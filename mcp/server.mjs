#!/usr/bin/env node
// clt MCP server — drive COMSOL on the Harvard FASRC cluster from any MCP client.
// Reuses the clt library (Keychain + TOTP auth, ControlMaster ssh, job bookkeeping).
//
// Register (already done via .mcp.json in this repo):
//   { "mcpServers": { "clt": { "command": "node", "args": ["mcp/server.mjs"] } } }

process.env.CLT_LIBRARY_MODE = '1'; // lib failures throw instead of process.exit

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../lib.js');

// MCP speaks JSON-RPC on stdout — everything the library prints goes to stderr.
console.log = (...a) => console.error(...a);

const cfg = lib.loadConfig();
const RUNS_DIR = path.join(os.homedir(), 'clt-runs');

// Guardrails: keep the AI polite on a shared cluster. Hard limits, not hints.
const GUARD = {
  maxActiveJobs: 4,
  maxCpus: 16,
  maxMemGB: 64,
  maxHours: 48,
  partitions: ['shared', 'test', 'serial_requeue'],
};

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: JSON.stringify({ error: String(msg) }) }], isError: true });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args ?? {}));
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
};

const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '-');

function checkResources({ cpus = 4, mem_gb = 8, hours = 1, partition = 'shared' }) {
  if (cpus > GUARD.maxCpus) throw new Error(`guardrail: cpus ${cpus} > ${GUARD.maxCpus}`);
  if (mem_gb > GUARD.maxMemGB) throw new Error(`guardrail: mem ${mem_gb}G > ${GUARD.maxMemGB}G`);
  if (hours > GUARD.maxHours) throw new Error(`guardrail: time ${hours}h > ${GUARD.maxHours}h`);
  if (!GUARD.partitions.includes(partition)) throw new Error(`guardrail: partition "${partition}" not in ${GUARD.partitions.join('/')}`);
  return { cpus, mem_gb, hours, partition };
}

async function activeJobs() {
  await lib.ensureMaster(cfg);
  const out = lib.run('ssh', [cfg.clusterHost, 'squeue --me -h -o "%i %T %M %j"']);
  if (!out.trim()) return [];
  return out.trim().split('\n').map((l) => {
    const t = l.trim().split(/\s+/);
    return { job_id: t[0], state: t[1], elapsed: t[2], name: t.slice(3).join(' ') };
  });
}

async function guardConcurrency() {
  const jobs = await activeJobs();
  if (jobs.length >= GUARD.maxActiveJobs) {
    throw new Error(`guardrail: ${jobs.length} jobs already active (max ${GUARD.maxActiveJobs}) — wait for one to finish or cancel it`);
  }
}

async function submitJob(name, jobDir, script, stageFiles) {
  lib.run('ssh', [cfg.clusterHost, `mkdir -p ${jobDir}`]);
  for (const [remoteName, localPath] of stageFiles) {
    lib.run('scp', ['-q', localPath, `${cfg.clusterHost}:${jobDir}/${remoteName}`]);
  }
  const out = lib.run('ssh', [cfg.clusterHost, 'sbatch'], { input: script });
  const id = (out.match(/\d+/) || [])[0];
  if (!id) throw new Error(`could not parse job id from sbatch output: ${out}`);
  lib.recordJob({ id, name, dir: jobDir, submitted: new Date().toISOString() });
  return { job_id: id, name, remote_dir: jobDir };
}

function codeScript(res, jobDir, className) {
  return `#!/bin/bash
#SBATCH -J ${className}
#SBATCH -p ${res.partition}
#SBATCH -c ${res.cpus}
#SBATCH --mem=${res.mem_gb}G
#SBATCH -t ${lib.slurmTime(res.hours * 3600)}
#SBATCH -o /dev/null
cd $HOME/${jobDir}
module load ${cfg.comsolModule}
comsol compile ${className}.java > compile.log 2>&1 || { echo COMPILE_FAILED >> compile.log; exit 1; }
comsol batch -np $SLURM_CPUS_PER_TASK -inputfile ${className}.class -nosave -batchlog batch.log >> compile.log 2>&1
`;
}

function findRecorded(job_id) {
  const rec = lib.loadJobs().find((j) => j.id === job_id);
  if (!rec) throw new Error(`job ${job_id} not in this tool's records (${path.join(os.homedir(), '.config/clt/jobs.json')})`);
  return rec;
}

const server = new McpServer({ name: 'clt-comsol', version: '0.1.0' });

server.tool(
  'run_code',
  'Compile and run COMSOL Java API code on the Harvard cluster as an async Slurm job. The source must contain one public class in COMSOL model-Java convention (public static Model run(), main calling it). Working directory is the job dir: write CSVs/PNGs to relative paths. Returns a job_id to poll with job_status. See references/HelloBox.java and references/CONVENTIONS.md for idioms and known API traps.',
  {
    java_source: z.string().describe('complete Java source file content'),
    label: z.string().optional().describe('short run label for bookkeeping'),
    mph_file: z.string().optional().describe('optional .mph (local path, or filename fetched from Windows) staged into the job dir as in.mph — use with code that calls ModelUtil.load("m", "in.mph"), e.g. the Inspect template'),
    cpus: z.number().optional(),
    mem_gb: z.number().optional(),
    hours: z.number().optional().describe('wall-time limit, default 1'),
    partition: z.string().optional(),
  },
  wrap(async (a) => {
    const res = checkResources(a);
    await guardConcurrency();
    const className = (a.java_source.match(/public\s+class\s+(\w+)/) || [])[1];
    if (!className) throw new Error('no `public class X` found in java_source');
    const name = (a.label || className).replace(/[^\w.-]/g, '_');
    const jobDir = `${cfg.remoteDir}/mcp-${name}-${stamp()}`;
    const tmp = path.join(os.tmpdir(), `${className}.java`);
    fs.writeFileSync(tmp, a.java_source);
    const stage = [[`${className}.java`, tmp]];
    if (a.mph_file) stage.push(['in.mph', await lib.stageInputFile(cfg, a.mph_file)]);
    return submitJob(name, jobDir, codeScript(res, jobDir, className), stage);
  })
);

server.tool(
  'run_model',
  'Run an existing .mph file on the cluster via comsol batch as an async Slurm job. file may be a local path on this Mac or a bare filename to fetch from the configured Windows machine. Returns a job_id.',
  {
    file: z.string().describe('.mph path (local) or filename (fetched from Windows)'),
    study: z.string().optional().describe('study tag, e.g. std2'),
    methodcall: z.string().optional().describe('method call tag, e.g. methodcall6'),
    pname: z.string().optional().describe('comma-separated parameter names for -pname'),
    plist: z.string().optional().describe('comma-separated parameter values for -plist'),
    cpus: z.number().optional(),
    mem_gb: z.number().optional(),
    hours: z.number().optional(),
    partition: z.string().optional(),
  },
  wrap(async (a) => {
    const res = checkResources(a);
    await guardConcurrency();
    const local = await lib.stageInputFile(cfg, a.file);
    const name = path.basename(a.file, '.mph').replace(/[^\w.-]/g, '_');
    const jobDir = `${cfg.remoteDir}/mcp-${name}-${stamp()}`;
    const extra = [];
    if (a.study) extra.push('-study', a.study);
    if (a.methodcall) extra.push('-methodcall', a.methodcall);
    if (a.pname && a.plist) extra.push('-pname', a.pname, '-plist', a.plist);
    const script = lib.sbatchScript(cfg, name, jobDir, extra, {
      time: lib.slurmTime(res.hours * 3600),
      mem: `${res.mem_gb}G`,
      cpus: res.cpus,
      partition: res.partition,
      email: '',
    });
    return submitJob(name, jobDir, script, [['in.mph', local]]);
  })
);

server.tool(
  'job_status',
  'State of one job (with progress % and ETA when running) or, with no job_id, all active jobs plus recent submissions.',
  { job_id: z.string().optional() },
  wrap(async ({ job_id }) => {
    if (!job_id) {
      return { active: await activeJobs(), recent: lib.loadJobs().slice(-8) };
    }
    await lib.ensureMaster(cfg);
    const q = lib.run('ssh', [cfg.clusterHost, `squeue -h -j ${job_id} -o "%T %M"`]).trim();
    if (q) {
      const [state, elapsed] = q.split(/\s+/);
      let progress_pct = null;
      let eta = null;
      const rec = lib.loadJobs().find((j) => j.id === job_id);
      if (rec && state === 'RUNNING') {
        const pct = Number(lib.run('ssh', [cfg.clusterHost,
          `grep -o "Current Progress: *[0-9]*" ${rec.dir}/batch.log 2>/dev/null | tail -1 | grep -o "[0-9]*$" || true`]).trim());
        if (pct) {
          progress_pct = pct;
          const e = lib.etaParts(pct, lib.slurmSeconds(elapsed));
          if (e) eta = { remaining_s: Math.round(e.remaining), finish_eastern: e.finish };
        }
      }
      return { job_id, state, elapsed, progress_pct, eta, finished: false };
    }
    const final = lib.run('ssh', [cfg.clusterHost, `sacct -n -X -j ${job_id} -o State,Elapsed`]).trim().split(/\s+/);
    return { job_id, state: final[0] || 'UNKNOWN', elapsed: final[1] || null, finished: true };
  })
);

server.tool(
  'job_log',
  'Tail of a job\'s COMSOL batch log and compile log — read this whenever a job fails or to see solver progress detail.',
  { job_id: z.string(), lines: z.number().optional() },
  wrap(async ({ job_id, lines = 40 }) => {
    const rec = findRecorded(job_id);
    await lib.ensureMaster(cfg);
    const batch = lib.run('ssh', [cfg.clusterHost, `tail -n ${lines} ${rec.dir}/batch.log 2>/dev/null || true`]);
    const compile = lib.run('ssh', [cfg.clusterHost, `tail -n 15 ${rec.dir}/compile.log 2>/dev/null || true`]);
    return { job_id, batch_log: batch, compile_log: compile };
  })
);

server.tool(
  'wait_for_job',
  'Poll until the job reaches a terminal state or timeout_s elapses (max 240 s — for longer jobs return and poll job_status instead).',
  { job_id: z.string(), timeout_s: z.number().optional() },
  wrap(async ({ job_id, timeout_s = 120 }) => {
    const deadline = Date.now() + Math.min(timeout_s, 240) * 1000;
    await lib.ensureMaster(cfg);
    for (;;) {
      const q = lib.run('ssh', [cfg.clusterHost, `squeue -h -j ${job_id} -o %T`]).trim();
      if (!q) {
        const final = lib.run('ssh', [cfg.clusterHost, `sacct -n -X -j ${job_id} -o State,Elapsed`]).trim().split(/\s+/);
        return { job_id, state: final[0] || 'UNKNOWN', elapsed: final[1] || null, finished: true };
      }
      if (Date.now() > deadline) return { job_id, state: q, finished: false, timed_out: true };
      await sleep(10000);
    }
  })
);

server.tool(
  'fetch_artifacts',
  'Copy a finished job\'s output files (CSV/TXT/PNG/logs by default) to ~/clt-runs/<name>-<id>/ on this Mac and list the local paths.',
  { job_id: z.string(), patterns: z.array(z.string()).optional().describe('remote glob patterns, default ["*.csv","*.txt","*.png","*.log","frames/*.png"]') },
  wrap(async ({ job_id, patterns = ['*.csv', '*.txt', '*.png', '*.log', 'frames/*.png'] }) => {
    const rec = findRecorded(job_id);
    await lib.ensureMaster(cfg);
    const dest = path.join(RUNS_DIR, `${rec.name}-${rec.id}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const pat of patterns) {
      // per-pattern scp; missing matches are fine. Patterns naming a subdirectory
      // (frames/*.png) keep that structure locally so `cluster frames` finds them.
      const sub = pat.includes('/') ? path.join(dest, path.dirname(pat)) : dest;
      if (sub !== dest) fs.mkdirSync(sub, { recursive: true });
      spawnSync('scp', ['-q', `${cfg.clusterHost}:${rec.dir}/${pat}`, sub], { stdio: 'ignore' });
    }
    const files = fs.readdirSync(dest, { recursive: true })
      .map((f) => path.join(dest, f))
      .filter((f) => fs.statSync(f).isFile());
    if (!files.length) throw new Error(`no artifacts matched ${patterns.join(' ')} in ${rec.dir}`);
    return { job_id, local_dir: dest, files };
  })
);

server.tool(
  'cancel_job',
  'Cancel a queued or running job immediately.',
  { job_id: z.string() },
  wrap(async ({ job_id }) => {
    await lib.ensureMaster(cfg);
    lib.run('ssh', [cfg.clusterHost, `scancel ${job_id}`]);
    return { job_id, cancelled: true };
  })
);

server.tool(
  'lab_fairshare',
  'The lab\'s current fairshare score and per-member usage. Check this before and after big runs — keep the lab score healthy (>0.6) and this user\'s share modest.',
  {},
  wrap(async () => {
    await lib.ensureMaster(cfg);
    const out = lib.run('ssh', [cfg.clusterHost,
      'acct=$(sacctmgr -n show assoc user=$(whoami) format=account%30 | head -1 | xargs); ' +
      'sshare -A "$acct" -a --format=Account%20,User%14,RawShares,NormShares,RawUsage,EffectvUsage']);
    let account = null;
    let score = null;
    let total = 0;
    const users = [];
    for (const line of out.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t.length === 5 && /^\d+$/.test(t[3])) {
        account = t[0];
        total = Number(t[3]);
        const norm = Number(t[2]);
        const eff = Number(t[4]);
        if (norm > 0) score = 2 ** (-(eff / norm));
      } else if (t.length === 6 && t[2] === 'parent') {
        users.push({ user: t[1], raw_usage: Number(t[4]) });
      }
    }
    users.sort((a, b) => b.raw_usage - a.raw_usage);
    return {
      account,
      fairshare: score === null ? null : Number(score.toFixed(4)),
      healthy: score !== null && score >= 0.6,
      lab_total_tres_sec: total,
      users: users.map((u) => ({ ...u, share_of_lab: total ? `${((100 * u.raw_usage) / total).toFixed(2)}%` : null })),
    };
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('clt MCP server ready');
