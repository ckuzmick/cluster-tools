#!/usr/bin/env node
'use strict';

// clt — streamlined COMSOL job submission to the Harvard FASRC cluster (Cannon).
//
// Zero npm dependencies. Uses only macOS built-ins (ssh, scp, expect, security)
// and Node >= 18. See README.md for one-time setup.

const { execFileSync, spawnSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'clt');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const JOBS_PATH = path.join(CONFIG_DIR, 'jobs.json');

const KEYCHAIN_PASSWORD = 'clt-cluster-password';
const KEYCHAIN_TOTP = 'clt-cluster-totp';

const DEFAULT_CONFIG = {
  clusterHost: 'fasrc',              // Host alias in ~/.ssh/config (must have ControlMaster, see README)
  windowsHost: 'winbox',             // Host alias for the Windows box (AnyDesk TCP tunnel or LAN)
  windowsFolder: 'Documents/COMSOL', // where .mph files live, relative to the Windows user profile
  remoteDir: 'comsol_jobs',          // job directory on the cluster, relative to $HOME
  comsolModule: 'comsol',            // check `module avail comsol` on the cluster
  touchId: true,                     // use ./touchid helper if it has been compiled
  slurm: {
    partition: 'shared',
    cpus: 8,
    mem: '32G',
    time: '08:00:00',
    email: '',                       // set to get an email when the job finishes
  },
};

function die(msg) {
  // In library mode (MCP server etc.) failures must be catchable, not fatal.
  if (process.env.CLT_LIBRARY_MODE) throw new Error(msg);
  console.error(`cluster: ${msg}`);
  process.exit(1);
}

// Big friendly status words. Green by default; falls back to plain text
// when figlet isn't installed (brew install figlet).
function bannerText(text, color = '32', font = 'standard') {
  const width = String(process.stdout.columns || 120);
  const r = spawnSync('figlet', ['-f', font, '-w', width, text], { encoding: 'utf8' });
  const art = r.status === 0 ? r.stdout.replace(/\s+$/, '') : text;
  return `\x1b[1;${color}m${art}\x1b[0m`;
}

function banner(text, color = '32') {
  console.log(bannerText(text, color));
}

// Clear the visible screen (history is preserved in scrollback), print from
// the top, then — if the output overflows the window — land the viewport at
// the top of the output by jumping to the previous prompt mark (⌘↑ in
// Terminal.app, ⌘⇧↑ in iTerm2). Scrolling down reaches the prompt; typing any
// key snaps back to it. Needs Accessibility permission once; if not granted
// the keystroke is a silent no-op and you scroll up by hand.
function page(text) {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const tall = process.stdout.isTTY && body.split('\n').length > (process.stdout.rows || 24);
  // Short output: cleared screen, history kept — banner is naturally at the top.
  // Tall output: scrollback must be empty for a clean glow-free landing, so
  // clear it, print, then ⌘Home (plain scroll-to-top — no mark highlight):
  // banner on the first row, scroll down to reach the prompt.
  if (process.stdout.isTTY) process.stdout.write(tall ? '\x1b[2J\x1b[3J\x1b[H' : '\x1b[2J\x1b[H');
  process.stdout.write(body);
  if (tall && ['Apple_Terminal', 'iTerm.app'].includes(process.env.TERM_PROGRAM)) {
    spawnSync('osascript', ['-e', 'tell application "System Events" to key code 115 using command down'], { stdio: 'ignore' });
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    die(`\`${cmd} ${args.join(' ')}\` failed:\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout ?? '';
}

// ---------- config & job bookkeeping ----------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) die(`no config found at ${CONFIG_PATH} — run: cluster setup`);
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
}

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function recordJob(job) {
  const jobs = loadJobs();
  jobs.push(job);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(JOBS_PATH, JSON.stringify(jobs, null, 2));
}

const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({ ...loadState(), ...patch }));
}

function findJob(ref) {
  const jobs = loadJobs();
  if (jobs.length === 0) die('no jobs submitted yet');
  if (!ref) return jobs[jobs.length - 1];
  const match = [...jobs].reverse().find((j) => j.id === ref || j.name === ref);
  if (!match) die(`no recorded job matching "${ref}" — see ${JOBS_PATH}`);
  return match;
}

// ---------- secrets: Keychain + TOTP ----------

function keychainGet(service) {
  const r = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', service, '-w'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) die(`Keychain item "${service}" not found — run: cluster setup`);
  return r.stdout.trim();
}

function keychainSet(service, secret) {
  execFileSync('security', [
    'add-generic-password', '-U',
    '-a', os.userInfo().username,
    '-s', service,
    '-w', secret,
  ]);
}

function base32Decode(str) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of str.replace(/[\s=-]/g, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) die(`TOTP secret contains invalid base32 character "${c}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

function totpSecondsRemaining() {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

// ---------- Touch ID gate ----------

function touchIdGate(cfg) {
  if (!cfg.touchId) return;
  const helper = path.join(__dirname, 'touchid');
  if (!fs.existsSync(helper)) return; // optional — build with: swiftc touchid.swift -o touchid
  const r = spawnSync(helper, { stdio: 'inherit' });
  if (r.status !== 0) die('Touch ID authentication failed');
}

// ---------- cluster login (ControlMaster + expect) ----------

function masterAlive(cfg) {
  return spawnSync('ssh', ['-O', 'check', cfg.clusterHost], { stdio: 'ignore' }).status === 0;
}

// FASRC validates OTPs strictly: only the current 30s window counts, and a
// code is single-use. So: demand a code with plenty of window left, never
// reuse a window we already spent, and retry once with the next code.
async function waitForUsableCode() {
  const remaining = totpSecondsRemaining();
  if (remaining < 15) {
    console.log(`waiting ${remaining}s for a fresh 2FA code…`);
    await sleep((remaining + 1) * 1000);
  }
  const window = Math.floor(Date.now() / 30000);
  if (loadState().lastOtpWindow === window) {
    const wait = totpSecondsRemaining() + 1;
    console.log(`current 2FA code was already used — waiting ${wait}s for the next one…`);
    await sleep(wait * 1000);
  }
  saveState({ lastOtpWindow: Math.floor(Date.now() / 30000) });
}

async function ensureMaster(cfg) {
  if (masterAlive(cfg)) return;

  console.log(`logging in to ${cfg.clusterHost}…`);
  const password = keychainGet(KEYCHAIN_PASSWORD);
  const totpSecret = keychainGet(KEYCHAIN_TOTP);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await waitForUsableCode();
    if (expectLogin(cfg, password, totp(totpSecret)) && masterAlive(cfg)) {
      console.log('connected (session will be reused for subsequent commands).');
      return;
    }
    if (attempt === 1) console.log('login rejected — retrying once with the next 2FA code…');
  }
  banner('failed', '31');
  die(
    'login failed twice — likely a wrong password or TOTP seed.\n' +
    '  Compare `cluster code` against your OpenAuth app, and try `ssh ' +
    cfg.clusterHost + '` manually to see what the prompt looks like.'
  );
}

function expectLogin(cfg, password, code) {
  // Secrets are passed via the environment, never on a command line or in the script.
  const expectScript = String.raw`
log_user 0
set timeout 45
set tries 0
spawn ssh -fN ${cfg.clusterHost}
expect {
  -nocase -re "yes/no|fingerprint" { send -- "yes\r"; exp_continue }
  -nocase -re "password.*:" {
    incr tries
    if {$tries > 1} { exit 5 }
    send -- "$env(CLT_PW)\r"
    exp_continue
  }
  -nocase -re "(verification|code).*:" { send -- "$env(CLT_OTP)\r"; exp_continue }
  eof {}
  timeout { exit 2 }
}
set r [wait]
exit [lindex $r 3]
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clt-'));
  const scriptPath = path.join(tmpDir, 'login.exp');
  try {
    fs.writeFileSync(scriptPath, expectScript, { mode: 0o600 });
    const r = spawnSync('expect', ['-f', scriptPath], {
      env: { ...process.env, CLT_PW: password, CLT_OTP: code },
      encoding: 'utf8',
    });
    if (r.status !== 0) return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!masterAlive(cfg)) {
    die(
      'login succeeded but no ControlMaster socket exists.\n' +
      '  Add the ControlMaster block for this host to ~/.ssh/config (see README.md).'
    );
  }
  return true;
}

// ---------- run reports & accumulated lessons ----------
// Facts are captured automatically after every run; judgement is recorded
// explicitly. Both are fed back to the next session so the tool gets better
// with use instead of every session rediscovering the same traps.

const LESSONS_PATH = path.join(__dirname, 'references', 'LESSONS.md');

function readLessons() {
  try { return fs.readFileSync(LESSONS_PATH, 'utf8'); } catch { return ''; }
}

function recordLesson({ lesson, category = 'general', jobId = null }) {
  if (!lesson || !lesson.trim()) die('a lesson needs text');
  const existing = readLessons();
  const header = '# Lessons — using the clt MCP and COMSOL on this cluster\n\n'
    + 'Written by whoever (human or agent) learns something worth not relearning.\n'
    + 'Loaded at the start of every autopilot session; keep entries short and actionable.\n';
  const day = new Date().toISOString().slice(0, 10);
  const entry = `- **${category}** — ${lesson.trim()}${jobId ? ` \`(job ${jobId})\`` : ''} _${day}_\n`;
  if (existing.includes(lesson.trim())) return { added: false, reason: 'already recorded' };
  fs.mkdirSync(path.dirname(LESSONS_PATH), { recursive: true });
  fs.writeFileSync(LESSONS_PATH, (existing || header) + entry);
  return { added: true, path: LESSONS_PATH, entry: entry.trim() };
}

/** Everything worth knowing about one finished run, gathered without judgement. */
async function runReport(cfg, ref) {
  const job = /^\d+$/.test(ref || '') ? { id: ref, name: ref, dir: null } : findJob(ref);
  const rec = loadJobs().find((j) => j.id === job.id) || job;
  await ensureMaster(cfg);

  const acct = run('ssh', [cfg.clusterHost,
    `sacct -X -n -P -j ${job.id} -o State,Elapsed,ReqCPUS,ReqMem,Partition`]).trim().split('|');
  let e = {};
  try { e = await effStatus(cfg, job.id); } catch { /* accounting may lag */ }

  let errors = [];
  let artifacts = [];
  if (rec.dir) {
    const errRaw = run('ssh', [cfg.clusterHost,
      `grep -A4 -iE "^\\*+Error|Error running java|COMPILE_FAILED|error:" ${rec.dir}/batch.log ${rec.dir}/compile.log 2>/dev/null | head -20 || true`]);
    errors = errRaw.trim().split('\n').filter((l) => l.trim() && !/^--$/.test(l)).slice(0, 12);
    artifacts = run('ssh', [cfg.clusterHost, `ls ${rec.dir} 2>/dev/null || true`]).trim().split('\n').filter(Boolean);
  }

  const report = {
    job_id: job.id,
    name: rec.name,
    submitted: rec.submitted || null,
    remote_dir: rec.dir || null,
    state: (acct[0] || '').replace(/ by \d+$/, '') || 'UNKNOWN',
    elapsed: acct[1] || null,
    requested: { cpus: Number(acct[2]) || null, mem: acct[3] || null, partition: acct[4] || null },
    used: e.cpuPct === undefined ? null
      : { cpu_pct: e.cpuPct, mem_used_gb: e.memUsedGb, mem_req_gb: e.memReqGb, mem_pct: e.memPct },
    errors,
    artifacts,
  };

  // Persist alongside the fetched results so it survives the session.
  const dest = path.join(os.homedir(), 'clt-runs', `${rec.name}-${job.id}`);
  fs.mkdirSync(dest, { recursive: true });
  const md = [`# Run report — ${rec.name} (job ${job.id})`, '',
    `- state: **${report.state}**  ·  elapsed ${report.elapsed || '?'}`,
    `- requested: ${report.requested.cpus || '?'} cpus, ${report.requested.mem || '?'}, ${report.requested.partition || '?'}`,
    report.used ? `- actually used: cpu ${report.used.cpu_pct}%, memory ${
      (report.used.mem_used_gb ?? 0).toFixed(1)} GB of ${report.used.mem_req_gb ?? '?'} GB (${report.used.mem_pct}%)` : '- usage: not yet in accounting',
    `- remote dir: \`${report.remote_dir || '?'}\``,
    artifacts.length ? `- artifacts: ${artifacts.join(', ')}` : '',
    errors.length ? `\n## Errors\n\n\`\`\`\n${errors.join('\n')}\n\`\`\`` : '\nNo errors found in the logs.',
    '', '_generated by `cluster report`_', ''].filter((l) => l !== '').join('\n');
  fs.writeFileSync(path.join(dest, 'RUN_NOTES.md'), md);
  report.local_notes = path.join(dest, 'RUN_NOTES.md');
  return report;
}

async function report(cfg, rest) {
  const r = await runReport(cfg, rest.find((a) => !a.startsWith('--')));
  const okState = /COMPLETED/.test(r.state);
  const view = [bannerText(okState ? 'report' : 'report', okState ? '34' : ramp(0)), '',
    `  \x1b[1m${r.name}\x1b[0m \x1b[2m· job ${r.job_id} · ${r.state} · ${r.elapsed || '?'}\x1b[0m`, '',
    `  requested   \x1b[2m${r.requested.cpus} cpus · ${r.requested.mem} · ${r.requested.partition}\x1b[0m`];
  if (r.used) {
    view.push(`  used        \x1b[2mcpu ${r.used.cpu_pct}% · memory ${(r.used.mem_used_gb ?? 0).toFixed(1)} GB`
      + ` of ${r.used.mem_req_gb} GB (${r.used.mem_pct}%)\x1b[0m`);
  }
  if (r.artifacts.length) view.push(`  artifacts   \x1b[2m${r.artifacts.join(', ')}\x1b[0m`);
  if (r.errors.length) {
    view.push('', `  \x1b[${ramp(0)}merrors\x1b[0m`);
    for (const l of r.errors.slice(0, 8)) view.push(`    \x1b[2m${l.slice(0, (process.stdout.columns || 100) - 6)}\x1b[0m`);
  }
  view.push('', `  \x1b[2mwritten to ${r.local_notes}\x1b[0m`);
  page(view.join('\n'));
}

function lessons() {
  const text = readLessons();
  if (!text.trim()) {
    page([bannerText('lessons', '34'), '',
      '  \x1b[2mnothing recorded yet — agents add entries with the record_lesson tool,\x1b[0m',
      `  \x1b[2mor edit ${LESSONS_PATH} by hand\x1b[0m`].join('\n'));
    return;
  }
  const lines = text.split('\n').map((l) => {
    const m = /^- \*\*(.+?)\*\* — (.*?)(\s*_\d{4}-\d{2}-\d{2}_)?$/.exec(l);
    if (!m) return l.startsWith('#') ? `\x1b[1m${l.replace(/^#+\s*/, '')}\x1b[0m` : `\x1b[2m${l}\x1b[0m`;
    return `  \x1b[${ramp(0.75)}m${m[1].padEnd(14)}\x1b[0m ${m[2]}`;
  });
  page([bannerText('lessons', '34'), '', ...lines].join('\n'));
}

// ---------- efficiency: what a job actually used ----------

/** Parse `seff` into numbers. Fairshare bills what you ASK for, so over-requesting costs real priority. */
async function effStatus(cfg, ref) {
  const job = /^\d+$/.test(ref || '') ? { id: ref, name: ref } : findJob(ref);
  await ensureMaster(cfg);
  const raw = run('ssh', [cfg.clusterHost, `seff ${job.id} 2>&1`]);
  const num = (re) => { const m = re.exec(raw); return m ? Number(m[1]) : null; };
  const gb = (re) => {
    const m = re.exec(raw);
    if (!m) return null;
    const v = Number(m[1]);
    return /MB/i.test(m[2]) ? v / 1024 : /KB/i.test(m[2]) ? v / 1048576 : v;
  };
  return {
    id: job.id,
    name: job.name,
    state: (/State:\s*(\S+)/.exec(raw) || [])[1] || '?',
    cores: num(/Cores per node:\s*(\d+)/) ?? num(/Cores:\s*(\d+)/),
    wall: (/Job Wall-clock time:\s*(\S+)/.exec(raw) || [])[1] || '',
    cpuPct: num(/CPU Efficiency:\s*([\d.]+)%/),
    memUsedGb: gb(/Memory Utilized:\s*([\d.]+)\s*(\w+)/),
    memReqGb: gb(/Memory Efficiency:.*?of\s*([\d.]+)\s*(\w+)/),
    memPct: num(/Memory Efficiency:\s*([\d.]+)%/),
    raw,
  };
}

async function eff(cfg, rest) {
  const e = await effStatus(cfg, rest.find((a) => !a.startsWith('--')));
  if (e.cpuPct === null && e.memPct === null) die(`no accounting for job ${e.id} yet:\n${e.raw.trim()}`);

  const bar = (pct, w = 26) => {
    const fill = Math.max(0, Math.min(w, Math.round((w * pct) / 100)));
    // high efficiency is good; a low bar means resources were requested and wasted
    return `\x1b[${ramp(Math.min(1, pct / 80))}m${'█'.repeat(fill)}\x1b[0m\x1b[2m${'░'.repeat(w - fill)}\x1b[0m`;
  };

  const view = [bannerText('efficiency', '34'), '',
    `  \x1b[1m${e.name}\x1b[0m \x1b[2m· job ${e.id} · ${e.state} · ran ${e.wall} on ${e.cores} cores\x1b[0m`, ''];
  if (e.cpuPct !== null) {
    view.push(`  cpu     ${bar(e.cpuPct)}  \x1b[${ramp(Math.min(1, e.cpuPct / 80))}m${e.cpuPct.toFixed(0).padStart(3)}%\x1b[0m`
      + `  \x1b[2mof ${e.cores} cores\x1b[0m`);
  }
  if (e.memPct !== null) {
    view.push(`  memory  ${bar(e.memPct)}  \x1b[${ramp(Math.min(1, e.memPct / 80))}m${e.memPct.toFixed(0).padStart(3)}%\x1b[0m`
      + `  \x1b[2m${e.memUsedGb.toFixed(1)} GB used of ${e.memReqGb.toFixed(0)} GB\x1b[0m`);
  }

  // Right-sizing. Fairshare bills allocated CPUs + memory, so an over-request is
  // priority spent on nothing, and bigger asks also queue more slowly.
  const tips = [];
  if (e.memUsedGb !== null && e.memReqGb) {
    const want = Math.max(4, Math.ceil((e.memUsedGb * 1.5) / 4) * 4);
    if (want < e.memReqGb * 0.75) {
      const saved = Math.round(100 * (1 - (e.cores + want / 4) / (e.cores + e.memReqGb / 4)));
      tips.push(`memory: ask for \x1b[1m${want}G\x1b[0m next time (peak ${e.memUsedGb.toFixed(1)} GB + 50% headroom)`
        + ` \x1b[2m— about ${saved}% cheaper in fairshare\x1b[0m`);
    }
  }
  if (e.cpuPct !== null && e.cpuPct < 50 && e.cores > 4) {
    tips.push(`cpu: ${e.cpuPct.toFixed(0)}% of ${e.cores} cores — COMSOL scales poorly past the point where`
      + ` the mesh fits; try \x1b[1m${Math.max(4, Math.round(e.cores / 2))}\x1b[0m and compare wall-clock`);
  }
  if (tips.length) view.push('', ...tips.map((t) => `  → ${t}`));
  else view.push('', '  \x1b[2m→ well sized; nothing obvious to reclaim\x1b[0m');
  view.push('', '  \x1b[2mfairshare bills what you REQUEST, not what you use\x1b[0m');
  page(view.join('\n'));
}

// ---------- cluster load ----------

async function load(cfg, rest) {
  await ensureMaster(cfg);
  const want = rest.find((a) => !a.startsWith('--')) || 'shared';
  const parts = run('ssh', [cfg.clusterHost, 'sinfo -h -o "%P|%C|%D"']).trim().split('\n');
  const nodes = run('ssh', [cfg.clusterHost, `sinfo -h -N -o "%T" -p ${want} 2>/dev/null`]).trim().split('\n');

  const view = [bannerText('cluster', '34'), ''];
  const rows = [];
  for (const line of parts) {
    const [name, cores] = line.split('|');
    if (!cores) continue;
    const [a, i, o, t] = cores.split('/').map(Number);
    if (!t) continue;
    rows.push({ name: name.replace('*', ''), a, i, o, t, busy: a / t });
  }
  rows.sort((x, y) => y.t - x.t);
  const W = 30;
  for (const r of rows.slice(0, 10)) {
    const fill = Math.round(W * r.busy);
    const idleW = Math.round(W * (r.i / r.t));
    const bar = `\x1b[${ramp(1 - r.busy)}m${'█'.repeat(fill)}\x1b[0m`
      + `\x1b[${ramp(1)}m${'▁'.repeat(Math.max(0, Math.min(W - fill, idleW)))}\x1b[0m`
      + `\x1b[2m${'░'.repeat(Math.max(0, W - fill - idleW))}\x1b[0m`;
    view.push(`  ${r.name.padEnd(22)}${bar} \x1b[${ramp(1 - r.busy)}m${(100 * r.busy).toFixed(0).padStart(3)}%\x1b[0m`
      + `  \x1b[2m${r.i.toLocaleString('en-US')} of ${r.t.toLocaleString('en-US')} cores free\x1b[0m`);
  }

  // Node-state mosaic: one block per node, so the shape of the partition is visible.
  if (nodes.length && nodes[0]) {
    const glyph = (st) => {
      if (/^alloc/.test(st)) return `\x1b[${ramp(0)}m█\x1b[0m`;      // full
      if (/^mix/.test(st)) return `\x1b[${ramp(0.45)}m█\x1b[0m`;     // partly used
      if (/^idle/.test(st)) return `\x1b[${ramp(1)}m█\x1b[0m`;       // free
      return '\x1b[2m█\x1b[0m';                                       // drain/down/resv
    };
    const per = Math.max(20, Math.min(72, (process.stdout.columns || 100) - 6));
    view.push('', `  \x1b[2m${want} — ${nodes.length} nodes\x1b[0m`);
    for (let k = 0; k < nodes.length; k += per) {
      view.push('  ' + nodes.slice(k, k + per).map((n) => glyph(n.trim())).join(''));
    }
    const tally = nodes.reduce((m, n) => (m[n.trim()] = (m[n.trim()] || 0) + 1, m), {});
    view.push('  ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([st, n]) => `${glyph(st)}\x1b[2m ${st} ${n}\x1b[0m`).join('  '));
  }
  view.push('', '  \x1b[2mbar: █ allocated  ▁ idle  ░ reserved/down  ·  cluster load [partition]\x1b[0m');
  page(view.join('\n'));
}

// ---------- COMSOL licence seats ----------

const LICENSE_SERVER = '27005@research-license.int.seas.harvard.edu';
const LMSTAT = '/n/sw/comsol/comsol64/license/glnxa64/lmstat';

// The licence server is firewalled from the login node, so the query has to run
// on a compute node. That costs a tiny allocation, hence the cache.
/** Parsed licence state, shared by the CLI view and the MCP tool. */
async function licenseStatus(cfg, { refresh = false } = {}) {
  const cached = loadState().licenses;
  let ageMin = cached ? (Date.now() - new Date(cached.at).getTime()) / 60000 : Infinity;
  let raw;
  if (cached && ageMin < 5 && !refresh) {
    raw = cached.raw;
  } else {
    await ensureMaster(cfg);
    console.log('asking a compute node (the licence server is unreachable from the login node)…');
    raw = run('ssh', [cfg.clusterHost,
      `srun -p test -t 2 -c 1 --mem=1G ${LMSTAT} -c ${LICENSE_SERVER} -a 2>&1`]);
    saveState({ licenses: { at: new Date().toISOString(), raw } });
    ageMin = 0;
  }

  // Parse feature totals and, under each, who currently holds a seat.
  const feats = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const head = /^Users of (\S+):\s+\(Total of (\d+) licenses? issued;\s+Total of (\d+) licenses? in use\)/.exec(line);
    if (head) {
      cur = { name: head[1], total: Number(head[2]), used: Number(head[3]), who: [] };
      feats.push(cur);
      continue;
    }
    const user = /^\s+(\S+)\s+\S+.*start\s+(.+?)\s*$/.exec(line);
    if (user && cur) cur.who.push({ user: user[1], since: user[2] });
  }
  if (!feats.length) die(`could not read licence status:\n${raw.trim().split('\n').slice(-3).join('\n')}`);
  for (const f of feats) f.free = f.total - f.used;
  return { ageMin, features: feats };
}

async function licenses(cfg, rest) {
  const all = rest.includes('--all');
  const { ageMin, features: feats } = await licenseStatus(cfg, { refresh: rest.includes('--refresh') });

  const busy = feats.filter((f) => f.used > 0);
  const always = feats.filter((f) => /^COMSOL(BATCH)?$/.test(f.name));
  const shown = all ? feats.filter((f) => f.total > 0)
    : [...new Set([...always, ...busy])].sort((a, b) => (b.used / b.total) - (a.used / a.total) || b.used - a.used);

  const view = [bannerText('seats', '34'), ''];
  const W = 22;
  for (const f of shown) {
    const frac = f.total ? f.used / f.total : 0;
    const barW = 14;
    const fill = Math.round(barW * frac);
    const c = ramp(1 - frac);                      // green = seats free, red = saturated
    const bar = `\x1b[${c}m${'█'.repeat(fill)}\x1b[0m\x1b[2m${'░'.repeat(barW - fill)}\x1b[0m`;
    view.push(`  ${f.name.padEnd(W)}${bar}  \x1b[${c}m${String(f.used).padStart(2)}/${String(f.total).padEnd(3)}\x1b[0m`
      + `\x1b[2m${f.total - f.used} free${f.who.length ? '  ·  ' + f.who.map((w) => w.user).join(', ') : ''}\x1b[0m`);
  }
  const idle = feats.filter((f) => f.total > 0 && f.used === 0).length;
  view.push('',
    `\x1b[2m  ${shown.length} shown${all ? '' : `, ${idle} idle features hidden (--all)`}`
    + `  ·  checked ${ageMin < 1 ? 'just now' : `${Math.round(ageMin)} min ago`} (--refresh)\x1b[0m`,
    '\x1b[2m  Seats are shared across SEAS. A batch job needs COMSOLBATCH plus the BATCH seat\x1b[0m',
    '\x1b[2m  for each module it uses, so the scarcest module caps how many jobs can run at once.\x1b[0m');
  page(view.join('\n'));
}

// ---------- doctor: find the broken link in the setup chain ----------

// Every step in README setup can fail silently and the resulting errors are
// unhelpful ("scp: Connection closed"). This walks the whole chain and names
// what is wrong. It NEVER logs in — a diagnostic that burns OTP codes would
// be worse than the problem.
function doctor() {
  const OK = 'ok', WARN = 'warn', BAD = 'bad';
  const mark = { ok: `\x1b[${ramp(1)}m✓\x1b[0m`, warn: `\x1b[${ramp(0.55)}m!\x1b[0m`, bad: `\x1b[${ramp(0)}m✗\x1b[0m` };
  const out = [];
  let bad = 0, warn = 0;
  const check = (label, status, detail, fix) => {
    if (status === BAD) bad++;
    if (status === WARN) warn++;
    out.push(`  ${mark[status]} ${label.padEnd(26)}\x1b[2m${detail || ''}\x1b[0m`
      + (fix && status !== OK ? `\n      \x1b[2m→ ${fix}\x1b[0m` : ''));
  };

  // --- local ---
  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 18 ? OK : BAD, `v${process.versions.node}`, 'install Node 18 or newer');

  const which = spawnSync('which', ['cluster'], { encoding: 'utf8' }).stdout.trim();
  let resolved = '';
  try { resolved = fs.realpathSync(which); } catch { /* not found */ }
  const mine = fs.realpathSync(path.join(__dirname, 'cluster.js'));
  check('`cluster` command', resolved === mine ? OK : BAD,
    which || 'not on PATH',
    resolved ? `resolves elsewhere — a stale shell alias? run: unalias cluster` : 'run `npm link` in the repo');

  let cfg = null;
  try { cfg = loadConfig(); } catch { /* handled below */ }
  check('config file', cfg ? OK : BAD, cfg ? CONFIG_PATH : 'missing', 'run: cluster setup');
  if (!cfg) cfg = DEFAULT_CONFIG;

  const sshCfg = path.join(os.homedir(), '.ssh', 'config');
  const text = fs.existsSync(sshCfg) ? fs.readFileSync(sshCfg, 'utf8') : '';
  const block = new RegExp(`^Host\\s+.*\\b${cfg.clusterHost}\\b[\\s\\S]*?(?=^Host\\s|\\Z)`, 'm').exec(text);
  const hasMaster = block && /ControlMaster\s+auto/i.test(block[0]) && /ControlPath/i.test(block[0]);
  check(`ssh config (${cfg.clusterHost})`, hasMaster ? OK : BAD,
    block ? (hasMaster ? 'ControlMaster set' : 'block found, no ControlMaster') : 'no Host block',
    'add the Host block from README step 2');

  const sockets = path.join(os.homedir(), '.ssh', 'sockets');
  check('~/.ssh/sockets', fs.existsSync(sockets) ? OK : BAD, sockets, 'mkdir -p ~/.ssh/sockets');

  const havePw = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username,
    '-s', KEYCHAIN_PASSWORD], { stdio: 'ignore' }).status === 0;
  const haveSeed = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username,
    '-s', KEYCHAIN_TOTP], { stdio: 'ignore' }).status === 0;
  check('Keychain: password', havePw ? OK : BAD, havePw ? 'stored' : 'missing', 'run: cluster setup');
  check('Keychain: TOTP seed', haveSeed ? OK : BAD, haveSeed ? 'stored' : 'missing', 'run: cluster setup');

  // Clock drift silently invalidates every TOTP code, and the failure looks
  // exactly like a wrong password.
  const sntp = spawnSync('sntp', ['time.apple.com'], { encoding: 'utf8', timeout: 8000 });
  const off = /([+-]?\d+\.\d+)\s*\+\/-/.exec(sntp.stdout || '');
  const drift = off ? Math.abs(Number(off[1])) : null;
  check('clock drift', drift === null ? WARN : drift < 5 ? OK : BAD,
    drift === null ? 'could not check' : `${drift.toFixed(2)}s`,
    'System Settings → General → Date & Time → set automatically');

  if (haveSeed) {
    try {
      const code = totp(keychainGet(KEYCHAIN_TOTP));
      check('2FA code', OK, `${code} (${totpSecondsRemaining()}s left) — must match your OpenAuth app`);
    } catch (e) {
      check('2FA code', BAD, e.message, 'reseed with: cluster setup');
    }
  }

  const alive = masterAlive(cfg);
  check('cluster session', alive ? OK : WARN, alive ? 'up' : 'not connected',
    'run: cluster login  (then re-run doctor for the remote checks)');

  // --- remote (only when a session already exists; never authenticate here) ---
  if (alive) {
    const remote = (cmd) => (spawnSync('ssh', [cfg.clusterHost, cmd], { encoding: 'utf8', timeout: 25000 }).stdout || '').trim();
    const who = remote('whoami');
    check('cluster login', who ? OK : BAD, who || 'no response');
    const mod = remote(`module avail ${cfg.comsolModule} 2>&1 | grep -c ${cfg.comsolModule} || true`);
    check(`COMSOL module (${cfg.comsolModule})`, Number(mod) > 0 ? OK : BAD,
      Number(mod) > 0 ? 'available' : 'not found',
      'check `module avail comsol` and set comsolModule in ~/.config/clt/config.json');
    const home = remote("df -h $HOME 2>/dev/null | tail -1 | awk '{print $5\" used of \"$2}'");
    const pctUsed = Number((home.match(/(\d+)%/) || [])[1] || 0);
    check('home space', pctUsed > 90 ? BAD : pctUsed > 75 ? WARN : OK, home || 'unknown',
      'delete old job dirs: cluster shell, then rm -rf ~/comsol_jobs/<old>');
    const q = remote('squeue --me -h | wc -l');
    check('your queue', OK, `${q.trim()} job(s)`);
  }

  // --- optional extras ---
  const opt = (label, present, detail, fix) => check(label, present ? OK : WARN, detail, fix);
  opt('Windows host config', /^Host\s+.*\b/m.test(text) && new RegExp(`\\b${cfg.windowsHost}\\b`).test(text),
    cfg.windowsHost, 'only needed to pull .mph files from the Windows PC (README step 5)');
  opt('figlet', spawnSync('which', ['figlet'], { stdio: 'ignore' }).status === 0,
    'big headers', 'brew install figlet');
  opt('Touch ID helper', fs.existsSync(path.join(__dirname, 'touchid')),
    'gates job submission', 'swiftc -O touchid.swift -o touchid');
  opt('MCP deps', fs.existsSync(path.join(__dirname, 'node_modules')),
    'for the AI tools', 'npm install');

  const verdict = bad ? bannerText('problems', ramp(0)) : warn ? bannerText('ok', ramp(0.6)) : bannerText('healthy', ramp(1));
  page([verdict, '', ...out, '',
    bad ? `  \x1b[2m${bad} blocking problem(s)${warn ? `, ${warn} warning(s)` : ''} — fix the ✗ lines above\x1b[0m`
        : warn ? `  \x1b[2m${warn} warning(s); nothing blocking\x1b[0m`
               : '  \x1b[2measy — everything checks out\x1b[0m'].join('\n'));
}

// ---------- pipeline steps ----------

async function stageInputFile(cfg, fileArg) {
  if (fs.existsSync(fileArg)) return path.resolve(fileArg); // already local — use as-is
  const name = path.basename(fileArg);
  const local = path.join(os.tmpdir(), `clt-${name}`);
  console.log(`fetching ${name} from ${cfg.windowsHost}:${cfg.windowsFolder}…`);
  run('scp', ['-q', `${cfg.windowsHost}:${cfg.windowsFolder}/${name}`, local]);
  return local;
}

function sbatchScript(cfg, name, jobDir, extraArgs, overrides = {}) {
  const s = { ...cfg.slurm, ...overrides };
  const comsolArgs = extraArgs.filter((a) => a !== '--').join(' ');
  const mail = s.email
    ? `#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=${s.email}\n`
    : '';
  return `#!/bin/bash
#SBATCH -J ${name}
#SBATCH -p ${s.partition}
#SBATCH -c ${s.cpus}
#SBATCH --mem=${s.mem}
#SBATCH -t ${s.time}
#SBATCH -o slurm-%j.log
${mail}module load ${cfg.comsolModule}
cd $HOME/${jobDir}
comsol batch -3drend sw -np $SLURM_CPUS_PER_TASK -inputfile in.mph -outputfile out.mph -batchlog batch.log ${comsolArgs}
`;
}

function slurmSeconds(str) {
  const m = (str || '').match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600) + Number(m[3]) * 60 + Number(m[4]);
}

function slurmTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const min = Math.ceil((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

function recommendMem(gb) {
  return `${Math.max(4, Math.ceil(gb * 1.5))}G`;
}

async function submit(cfg, fileArg, extraArgs) {
  if (!fileArg.endsWith('.mph')) die(`expected a .mph file, got "${fileArg}" (see: cluster help)`);
  touchIdGate(cfg);
  const localFile = await stageInputFile(cfg, fileArg);
  await ensureMaster(cfg);

  const name = path.basename(fileArg, '.mph').replace(/[^\w.-]/g, '_');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const jobDir = `${cfg.remoteDir}/${name}-${stamp}`;
  const script = sbatchScript(cfg, name, jobDir, extraArgs);

  console.log(`uploading to ${cfg.clusterHost}:${jobDir}…`);
  run('ssh', [cfg.clusterHost, `mkdir -p ${jobDir}`]);
  run('scp', ['-q', localFile, `${cfg.clusterHost}:${jobDir}/in.mph`]);

  const out = run('ssh', [cfg.clusterHost, `sbatch --chdir=$HOME/${jobDir}`], { input: script });
  const id = (out.match(/\d+/) || [])[0];
  if (!id) die(`could not parse job id from sbatch output:\n${out}`);

  recordJob({ id, name, dir: jobDir, submitted: new Date().toISOString() });
  banner('submitted');
  console.log(`batch job ${id} (${name})`);
  console.log(`  watch:   cluster status ${id}`);
  console.log(`  log:     cluster logs ${name}`);
  console.log(`  results: cluster fetch ${name}   (when finished)`);
}

// `cluster time file.mph [--minutes N] [-study stdN | -methodcall X]`
// Runs a time-boxed slice of the REAL job, then extrapolates total runtime
// and memory from how far COMSOL's progress got.
async function timeProbe(cfg, rest) {
  const fileArg = rest[0];
  if (!fileArg || !fileArg.endsWith('.mph')) {
    die('usage: cluster time <file.mph> [--minutes N] [comsol args, e.g. -study std2]');
  }
  let probeMin = 30;
  const extra = [];
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--minutes') probeMin = Number(rest[++i]) || 30;
    else extra.push(rest[i]);
  }

  touchIdGate(cfg);
  const localFile = await stageInputFile(cfg, fileArg);
  await ensureMaster(cfg);

  const name = `${path.basename(fileArg, '.mph').replace(/[^\w.-]/g, '_')}-probe`;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  const jobDir = `${cfg.remoteDir}/${name}-${stamp}`;
  const script = sbatchScript(cfg, name, jobDir, extra, { time: slurmTime(probeMin * 60), email: '' });

  run('ssh', [cfg.clusterHost, `mkdir -p ${jobDir}`]);
  run('scp', ['-q', localFile, `${cfg.clusterHost}:${jobDir}/in.mph`]);
  const out = run('ssh', [cfg.clusterHost, 'sbatch'], { input: script });
  const id = (out.match(/\d+/) || [])[0];
  if (!id) die(`could not parse job id from sbatch output:\n${out}`);
  recordJob({ id, name, dir: jobDir, submitted: new Date().toISOString() });

  console.log(`probe job ${id}: a ${probeMin}-minute slice of the real run${extra.length ? ` (${extra.join(' ')})` : ''}`);
  console.log('waiting — ^C stops watching (the probe itself keeps running; see cluster logs later)…');

  const deadline = Date.now() + (probeMin * 2 + 60) * 60000;
  for (;;) {
    await sleep(30000);
    const q = run('ssh', [cfg.clusterHost, `squeue -h -j ${id} -o "%T %M"`]).trim();
    if (!q) break;
    const pct = run('ssh', [cfg.clusterHost,
      `grep -o "Current Progress: *[0-9]*" ${jobDir}/batch.log 2>/dev/null | tail -1 | grep -o "[0-9]*$" || true`]).trim();
    console.log(`  ${q}${pct ? `  ·  ${pct}% through the study` : ''}`);
    if (Date.now() > deadline) die(`probe is taking too long (stuck in queue?) — check later with: cluster status ${id}`);
  }

  const acct = run('ssh', [cfg.clusterHost, `sacct -n -j ${id} -o State,Elapsed,MaxRSS`])
    .trim().split('\n').map((l) => l.trim().split(/\s+/));
  const state = acct[0]?.[0] || '?';
  const elapsed = slurmSeconds(acct[0]?.[1]);
  let memGB = 0;
  for (const row of acct) {
    const m = (row[2] || '').match(/^([\d.]+)([KMG])$/);
    if (m) memGB = Math.max(memGB, Number(m[1]) / { K: 1048576, M: 1024, G: 1 }[m[2]]);
  }

  let pct = 0;
  const log = run('ssh', [cfg.clusterHost,
    `grep -oE "(Current Progress: *[0-9]+|Physical memory: [0-9.]+ [GM]B)" ${jobDir}/batch.log 2>/dev/null || true`]);
  for (const line of log.split('\n')) {
    const p = line.match(/Current Progress: *(\d+)/);
    if (p) pct = Number(p[1]); // last occurrence wins
    const m = line.match(/Physical memory: ([\d.]+) ([GM])B/);
    if (m) memGB = Math.max(memGB, Number(m[1]) / (m[2] === 'M' ? 1024 : 1));
  }

  console.log('');
  if (state.startsWith('COMPLETED')) {
    banner('done');
    console.log(`the whole run finished inside the probe window: ${fmtDur(elapsed * 1000)}, peak memory ${memGB.toFixed(1)} GB.`);
    console.log(`the output is real — grab it with: cluster fetch ${name}`);
    console.log(`\nsettings for future runs of this model:  "time": "${slurmTime(elapsed * 1.5)}", "mem": "${recommendMem(memGB)}"`);
  } else if (pct > 0) {
    const total = Math.round((elapsed * 100) / pct);
    banner('estimate');
    console.log(`probe ran ${fmtDur(elapsed * 1000)} and reached ${pct}% of the study (state: ${state}).`);
    console.log(`estimated full runtime: ~${fmtDur(total * 1000)}   peak memory so far: ${memGB.toFixed(1)} GB`);
    console.log(`\nsuggested config:  "time": "${slurmTime(total * 1.5)}", "mem": "${recommendMem(memGB)}"`);
    console.log('\x1b[2mCOMSOL progress is nonlinear (meshing and eigensolves can park at one % for a while) — treat as ±2×.\x1b[0m');
  } else {
    banner('unclear', '33');
    console.log(`probe ended (${state}) after ${fmtDur(elapsed * 1000)} without reporting progress — check: cluster logs ${name}`);
  }
}

// Machine-readable status for the menu-bar app and any other poller.
// Deliberately NEVER logs in: a background poller that could trigger the
// expect+TOTP flow would burn one-time codes and risk locking the account.
// If the shared session is down it says so and returns nothing else.
function statusJson(cfg) {
  if (!masterAlive(cfg)) {
    console.log(JSON.stringify({ session: 'down', jobs: [] }));
    return;
  }
  const q = spawnSync('ssh', [cfg.clusterHost, 'squeue --me -h -o "%i|%j|%T|%M|%l|%C"'], { encoding: 'utf8' });
  if (q.status !== 0) {
    console.log(JSON.stringify({ session: 'error', jobs: [] }));
    return;
  }
  const recorded = loadJobs();
  const jobs = q.stdout.trim() ? q.stdout.trim().split('\n').map((line) => {
    const [id, name, state, elapsed, limit, cpus] = line.trim().split('|');
    const job = { id, name, state, elapsed, limit, cpus: Number(cpus) };
    const rec = recorded.find((r) => r.id === id);
    if (rec && state === 'RUNNING') {
      const probe = spawnSync('ssh', [cfg.clusterHost,
        `awk '/Current Progress:/ { if (match($0, /Current Progress: *[0-9]+/)) { ` +
        `p = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", p); ` +
        `if (p + 0 < last - 20) reset = 1; last = p + 0 } } ` +
        `/^-{3,}.*[Ss]olver.*in .*-{3,}>[[:space:]]*$/ { solves++ } ` +
        `END { print last + 0, reset + 0, solves + 0 }' ${rec.dir}/batch.log 2>/dev/null || true`],
        { encoding: 'utf8' });
      const [pct, reset, solves] = (probe.stdout || '').trim().split(/\s+/).map(Number);
      if (Number.isFinite(pct)) {
        job.stagePct = pct;
        job.solvesDone = solves || 0;
        job.multiStage = Boolean(reset);
        if (!reset) {
          const e = etaParts(pct, slurmSeconds(elapsed));
          if (e) job.finishEastern = e.finish;
        }
      }
    }
    return job;
  }) : [];
  console.log(JSON.stringify({ session: 'up', jobs }));
}

// `cluster jobs [--all]` — the history this tool has recorded, joined with
// Slurm's final verdict. Finding a past run is otherwise guesswork: logs,
// watch and fetch all take a name, but nothing listed the names.
async function jobsList(cfg, rest) {
  const recorded = loadJobs();
  if (!recorded.length) die('no jobs submitted yet');
  const shown = rest.includes('--all') ? [...recorded].reverse() : [...recorded].reverse().slice(0, 15);
  await ensureMaster(cfg);

  const verdicts = new Map();
  const out = run('ssh', [cfg.clusterHost,
    `sacct -X -n -P -j ${shown.map((j) => j.id).join(',')} -o JobID,State,Elapsed`]);
  for (const line of out.trim().split('\n')) {
    if (!line.trim()) continue;
    const [id, rawState, elapsed] = line.split('|');
    // sacct reports "CANCELLED by 34567"; the uid is noise in a history list
    const state = (rawState || '').trim().replace(/ by \d+$/, '');
    verdicts.set(id.split('.')[0].trim(), { state, elapsed: (elapsed || '').trim() });
  }

  const stateColor = (st) => {
    if (/^COMPLETED/.test(st)) return ramp(1);
    if (/^RUNNING/.test(st)) return ramp(0.75);
    if (/^PENDING|^REQUEUED|^SUSPENDED/.test(st)) return ramp(0.55);
    return ramp(0);                       // FAILED, TIMEOUT, CANCELLED, OOM
  };

  const view = [bannerText('jobs', '34'), ''];
  view.push(`\x1b[2m  ${'job id'.padEnd(10)}${'name'.padEnd(26)}${'submitted'.padEnd(18)}`
    + `${'state'.padEnd(12)}${'elapsed'.padStart(9)}   saved\x1b[0m`);
  for (const j of shown) {
    const v = verdicts.get(j.id) || { state: 'UNKNOWN', elapsed: '' };
    const when = new Date(j.submitted).toLocaleString('en-US',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const localDir = path.join(os.homedir(), 'clt-runs', `${j.name}-${j.id}`);
    const saved = fs.existsSync(localDir)
      ? `\x1b[${ramp(1)}m✓\x1b[0m`
      : '\x1b[2m·\x1b[0m';
    view.push(`  ${j.id.padEnd(10)}${j.name.slice(0, 25).padEnd(26)}\x1b[2m${when.padEnd(18)}\x1b[0m`
      + `\x1b[${stateColor(v.state)}m${v.state.slice(0, 11).padEnd(12)}\x1b[0m`
      + `${v.elapsed.padStart(9)}   ${saved}`);
  }
  view.push('',
    `\x1b[2m  ${shown.length} of ${recorded.length} recorded${rest.includes('--all') ? '' : ' (--all for the rest)'}`
    + ' · ✓ = artifacts fetched to ~/clt-runs\x1b[0m',
    '\x1b[2m  cluster logs <name> · cluster watch <name> · cluster fetch <name>\x1b[0m');
  page(view.join('\n'));
}

async function status(cfg, jobid) {
  await ensureMaster(cfg);
  if (jobid) {
    spawnSync('ssh', [cfg.clusterHost, `sacct -j ${jobid} --format=JobID,JobName%20,Partition,State,Elapsed,MaxRSS`], { stdio: 'inherit' });
    return;
  }
  const out = run('ssh', [cfg.clusterHost, `squeue --me -o "%.10i %.18j %.9P %.8T %.10M %.9l %.5C %R"`]);

  // Headline: the one number worth reading across the room. For a single job
  // that is its elapsed time, coloured by how much of the wall-time limit it has
  // eaten — jobs killed at the limit are a real and avoidable way to lose work.
  const rows = out.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/));
  const live = rows.filter((r) => r[3] === 'RUNNING');
  if (rows.length === 0) {
    banner('idle', DIM);
  } else if (rows.length === 1 && live.length === 1) {
    const [, name, , , elapsed, limit] = rows[0];
    const used = slurmSeconds(limit) ? slurmSeconds(elapsed) / slurmSeconds(limit) : 0;
    banner(elapsed, ramp(1 - Math.min(1, used)));
    const pctLimit = Math.round(100 * used);
    console.log(`\x1b[2m${name} · ${pctLimit}% of the ${limit} limit\x1b[0m\n`);
  } else {
    banner(live.length ? `${live.length} running` : `${rows.length} queued`, live.length ? GREEN : YELLOW);
    console.log('');
  }
  process.stdout.write(out);

  // ETA lines for running jobs this tool submitted (progress comes from batch.log).
  const jobs = loadJobs();
  for (const line of out.trim().split('\n').slice(1)) {
    const t = line.trim().split(/\s+/);
    const [id, , , state, elapsed] = t;
    if (state !== 'RUNNING') continue;
    const job = jobs.find((j) => j.id === id);
    if (!job) continue;
    // One pass over the log: last stage %, whether the meter has ever restarted
    // (i.e. it is per-stage, not whole-job), and how many solves have finished.
    const probe = run('ssh', [cfg.clusterHost,
      `awk '/Current Progress:/ { if (match($0, /Current Progress: *[0-9]+/)) { ` +
      `p = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", p) + 0; ` +
      `if (p + 0 < last - 20) reset = 1; last = p + 0 } } ` +
      `/^-{3,}.*[Ss]olver.*in .*-{3,}>[[:space:]]*$/ { solves++ } ` +
      `END { print last + 0, reset + 0, solves + 0 }' ${job.dir}/batch.log 2>/dev/null || true`]).trim();
    const [pct, reset, solves] = probe.split(/\s+/).map(Number);
    if (!Number.isFinite(pct)) continue;
    if (reset) {
      // Sub-task meter: report the stage honestly instead of a bogus whole-job ETA.
      console.log(`\x1b[2m  ${job.name}: stage ${pct}%  ·  ${solves} solve${solves === 1 ? '' : 's'} done`
        + `  ·  no overall ETA (multi-stage; cluster watch --points N)\x1b[0m`);
      continue;
    }
    const eta = etaParts(pct, slurmSeconds(elapsed));
    if (eta) {
      console.log(`\x1b[2m  ${job.name}: ${pct}%  ·  ~${fmtDur(eta.remaining * 1000)} left  ·  done ~${eta.finish}\x1b[0m`);
    }
  }
}

async function logs(cfg, ref) {
  const job = findJob(ref);
  await ensureMaster(cfg);
  spawnSync('ssh', [cfg.clusterHost,
    `tail -n 50 ${job.dir}/batch.log 2>/dev/null || tail -n 50 ${job.dir}/slurm-${job.id}.log`,
  ], { stdio: 'inherit' });
}

async function fetch(cfg, ref) {
  const job = findJob(ref);
  await ensureMaster(cfg);
  const dest = `${job.name}-out.mph`;
  console.log(`fetching ${job.dir}/out.mph → ./${dest}`);
  run('scp', ['-q', `${cfg.clusterHost}:${job.dir}/out.mph`, dest]);
  spawnSync('scp', ['-q', `${cfg.clusterHost}:${job.dir}/batch.log`, `${job.name}-batch.log`]);
  banner('done');
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// Clock time in Eastern (prints EDT/EST automatically); adds the weekday when
// the finish lands on a different day than today.
function easternFinish(ms) {
  const d = new Date(ms);
  const tz = { timeZone: 'America/New_York' };
  const time = d.toLocaleTimeString('en-US', { ...tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const sameDay = d.toLocaleDateString('en-US', tz) === new Date().toLocaleDateString('en-US', tz);
  return sameDay ? time : `${d.toLocaleDateString('en-US', { ...tz, weekday: 'short' })} ${time}`;
}

function etaParts(pct, elapsedSec) {
  if (!pct || pct <= 0 || pct >= 100 || !elapsedSec) return null;
  const remaining = (elapsedSec * (100 - pct)) / pct;
  return { remaining, finish: easternFinish(Date.now() + remaining * 1000) };
}

async function watch(cfg, ref, points) {
  const job = findJob(ref);
  await ensureMaster(cfg);

  // Non-interactive output (pipes, logs): just stream the file.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    spawnSync('ssh', [cfg.clusterHost, `tail -n 100 -F ${job.dir}/batch.log 2>/dev/null`], { stdio: 'inherit' });
    return;
  }

  const MAX_LINES = 5000;
  // COMSOL's "Current Progress: N %" is a SUB-TASK meter: it resets to 0 for every
  // geometry build, mesh and solve. Treating the latest value as whole-job progress
  // is wrong for anything multi-stage (a sweep resets it dozens of times). So:
  // track resets, count completed solves, and only claim an overall figure when we
  // legitimately have one — a single-meter job, or a known point count (--points N).
  let percent = 0;          // progress within the current stage
  let sawReset = false;     // proof the meter is per-stage, not overall
  let solvesDone = 0;       // completed eigenvalue/stationary solver blocks
  let phase = 'starting…';
  let mem = '';
  let state = '…';
  let finished = null;
  let scroll = 0; // lines scrolled up from the live tail; 0 = following
  let dirty = true;
  let done = false;
  let jobElapsedBase = null; // job runtime from squeue, extrapolated between polls
  let jobElapsedAt = 0;
  const tailLines = [];
  const started = Date.now();

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;
  let headLines = 3;                       // grows when the finish banner shows
  const bodyHeight = () => Math.max(1, rows() - headLines - 1);
  const maxScroll = () => Math.max(0, tailLines.length - bodyHeight());

  const tail = spawn('ssh', [cfg.clusterHost, `tail -n 1000 -F ${job.dir}/batch.log 2>/dev/null`]);
  let buf = '';
  tail.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    let added = 0;
    for (const line of lines) {
      const prog = line.match(/Current Progress:\s*(\d+)\s*%\s*-?\s*(.*)/);
      if (prog) {
        const p = Number(prog[1]);
        if (p < percent - 20) sawReset = true; // meter restarted: it is per-stage
        percent = p;
        if (prog[2].trim()) phase = prog[2].trim();
      }
      // Solver block footer, e.g. "----- Eigenvalue Solver 1 in Study/Solution 1 --->"
      if (/^-{3,}\s+\S.*\bin\b.*-{3,}>\s*$/.test(line) && /Solver/i.test(line)) solvesDone++;
      const phys = line.match(/Physical memory:\s*([\d.]+\s*[GMK]B)/i);
      if (phys) mem = phys[1];
      const old = line.match(/^Memory:\s*\d+\/(\d+)\s+\d+\/\d+/);
      if (old) mem = `${(Number(old[1]) / 1024).toFixed(1)} GB`;
      if (line.trim()) {
        tailLines.push(line);
        added++;
      }
    }
    if (tailLines.length > MAX_LINES) tailLines.splice(0, tailLines.length - MAX_LINES);
    // While scrolled up, keep the visible window anchored as new lines stream in.
    if (scroll > 0) scroll = Math.min(scroll + added, maxScroll());
    dirty = true;
  });

  function render() {
    const C = cols();
    const barWidth = Math.max(10, Math.min(C - 24, 50));
    const jobElapsed = jobElapsedBase !== null
      ? jobElapsedBase + (finished ? 0 : (Date.now() - jobElapsedAt) / 1000)
      : null;

    // Decide what the bar is allowed to claim.
    let barPct = percent;      // what to draw
    let barNote;               // what it honestly means
    let eta = null;
    if (points) {
      // Known point count: completed solves give a real overall figure.
      barPct = Math.min(100, Math.round((100 * solvesDone) / points));
      barNote = `point ${Math.min(solvesDone + 1, points)}/${points} · ${phase} ${percent}%`;
      if (!finished && solvesDone > 0 && solvesDone < points && jobElapsed) {
        const remaining = (jobElapsed / solvesDone) * (points - solvesDone);
        eta = { remaining, finish: easternFinish(Date.now() + remaining * 1000) };
      }
    } else if (sawReset) {
      // Multi-stage job, total unknown: report the stage, never the whole job.
      barNote = `${phase}${solvesDone ? `  ·  ${solvesDone} solve${solvesDone > 1 ? 's' : ''} done` : ''}`
        + '  \x1b[2m(stage progress — pass --points N for overall)\x1b[0m';
    } else {
      // Single progress meter for the whole run: the old, valid interpretation.
      barNote = phase;
      if (!finished && state === 'RUNNING') eta = etaParts(percent, jobElapsed);
    }
    const filledB = Math.round((barWidth * barPct) / 100);
    const bar2 = '█'.repeat(filledB) + '░'.repeat(barWidth - filledB);
    const etaStr = eta ? ` \x1b[2m·  ~${fmtDur(eta.remaining * 1000)} left  ·  done ~${eta.finish}\x1b[0m` : '';
    const summary = ` ${job.name}  ·  job ${job.id}  ·  ${state}  ·  `
      + `${fmtDur(jobElapsed !== null ? jobElapsed * 1000 : Date.now() - started)}${mem ? `  ·  ${mem}` : ''}`;
    const rule = ` \x1b[2m${'─'.repeat(C - 2)}\x1b[0m`;
    let head;
    if (finished) {
      // The run is over: the progress bar is meaningless now, so give the
      // verdict the space instead — readable from across the room.
      const good = finished === 'COMPLETED';
      const word = good ? 'done' : finished.replace(/\+$/, '').toLowerCase();
      head = [
        ...bannerText(word, good ? GREEN : RED).split('\n').map((l) => ' ' + l),
        summary,
        rule,
      ];
    } else {
      head = [
        summary,
        (` \x1b[32m${bar2}\x1b[0m ${String(barPct).padStart(3)}%  ${barNote}` + etaStr)
          .slice(0, C + 9 + (etaStr ? 8 : 0) + (barNote.includes('\x1b') ? 8 : 0)),
        rule,
      ];
    }
    headLines = head.length;
    const H = bodyHeight();
    const start = Math.max(0, tailLines.length - H - scroll);
    const body = tailLines.slice(start, start + H).map((l) => `\x1b[2m ${l.slice(0, C - 2)}\x1b[0m`);
    while (body.length < H) body.push('');
    const pos = scroll === 0
      ? (finished ? `${finished} — q to exit` : 'following')
      : `↑${scroll} lines (b to follow)`;
    const foot = [` \x1b[7m ↑↓ scroll · ⇞⇟ page · t/b top/bottom · q quit \x1b[0m \x1b[2m${pos}\x1b[0m`];
    process.stdout.write('\x1b[H' + [...head, ...body, ...foot].map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  }

  function cleanup(message) {
    if (done) return;
    done = true;
    tail.kill();
    clearInterval(paint);
    clearInterval(poll);
    clearInterval(tick);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h');
    if (message) console.log(message);
  }

  function quit() {
    cleanup(
      finished
        ? (finished === 'COMPLETED'
            ? `job ${job.id} (${job.name}) completed — grab results with: cluster fetch ${job.name}`
            : `job ${job.id} (${job.name}) ended with state ${finished} — check: cluster logs ${job.name}`)
        : `stopped watching — job ${job.id} keeps running (cluster watch to resume)`
    );
    process.exit(0);
  }

  function checkState() {
    const r = spawnSync('ssh', [cfg.clusterHost, `squeue -h -j ${job.id} -o "%T %M"`], { encoding: 'utf8' });
    // squeue EXITS NONZERO ("Invalid job id specified") once a finished job ages out
    // of the queue — treat that like an empty result and let sacct give the verdict,
    // otherwise the viewer waits forever on a job that ended hours ago.
    const s = r.status === 0 ? r.stdout.trim() : '';
    if (s) {
      const [st, el] = s.split(/\s+/);
      state = st;
      if (st === 'RUNNING' && el) {
        jobElapsedBase = slurmSeconds(el);
        jobElapsedAt = Date.now();
      }
    } else {
      // Job left the queue: show the verdict in the header but keep the TUI
      // open so the log can still be scrolled; q exits.
      const final = spawnSync('ssh', [cfg.clusterHost, `sacct -n -X -j ${job.id} -o State`], { encoding: 'utf8' });
      const verdict = final.status === 0 ? (final.stdout || '').trim().split(/\s+/)[0] : '';
      if (!verdict) return; // ssh hiccup, not a finished job — keep polling
      finished = verdict;
      state = finished;
      clearInterval(poll);
    }
    dirty = true;
  }

  const KEYSEQS = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[H': 'home', '\x1b[F': 'end' };
  function act(key) {
    const H = bodyHeight();
    if (key === 'up') scroll = Math.min(scroll + 1, maxScroll());
    else if (key === 'down') scroll = Math.max(0, scroll - 1);
    else if (key === 'wheelup') scroll = Math.min(scroll + 3, maxScroll());
    else if (key === 'wheeldown') scroll = Math.max(0, scroll - 3);
    else if (key === 'pgup') scroll = Math.min(scroll + H, maxScroll());
    else if (key === 'pgdn') scroll = Math.max(0, scroll - H);
    else if (key === 'home') scroll = maxScroll();
    else if (key === 'end') scroll = 0;
    else return;
    dirty = true;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    let s = b.toString('latin1');
    // Mouse wheel (SGR mouse reporting): button 64 = wheel up, 65 = wheel down.
    for (const m of s.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) {
      const btn = Number(m[1]);
      if (btn === 64) act('wheelup');
      else if (btn === 65) act('wheeldown');
    }
    s = s.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');
    if (KEYSEQS[s]) return act(KEYSEQS[s]);
    for (const ch of s) {
      if (ch === 'q' || ch === '\x03') return quit();
      if (ch === 'k') act('up');
      else if (ch === 'j') act('down');
      else if (ch === 't') act('home');
      else if (ch === 'b') act('end');
      else if (ch === ' ') act('pgdn');
    }
  });

  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
  // Safety net: whatever kills this process, never leave the terminal with
  // mouse reporting / alt screen / hidden cursor stuck on.
  process.on('exit', () => {
    if (!done) process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h');
  });
  const paint = setInterval(() => {
    if (dirty) { render(); dirty = false; }
  }, 100);
  const tick = setInterval(() => { if (!finished) dirty = true; }, 1000);
  const poll = setInterval(checkState, 10000);
  process.stdout.on('resize', () => { dirty = true; });
  process.on('SIGINT', quit);
  checkState();
  await new Promise(() => {}); // runs until quit()
}

// `cluster frames [name|jobid] [--embed] [--open]`
// Pull the frames/ PNGs a run captured (see references/Snapshots.java) and build
// a self-contained player so the build/solve can be replayed frame by frame.
// Relative <img> paths by default; --embed inlines base64 for a single portable
// file (publishable as an artifact, but much larger).
async function frames(cfg, rest) {
  const embed = rest.includes('--embed');
  const open = rest.includes('--open');
  const job = findJob(rest.find((a) => !a.startsWith('--')));
  await ensureMaster(cfg);

  const dest = path.join(os.homedir(), 'clt-runs', `${job.name}-${job.id}`);
  const framesDir = path.join(dest, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  console.log(`fetching frames from ${job.dir}/frames/…`);
  spawnSync('scp', ['-q', `${cfg.clusterHost}:${job.dir}/frames/*.png`, framesDir], { stdio: 'ignore' });

  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort();
  if (!files.length) {
    die(`no frames in ${job.dir}/frames/ — did the model call the snapshot helpers?\n` +
        '  see references/Snapshots.java');
  }

  const label = (f) => f.replace(/^\d+_/, '').replace(/\.png$/, '').replace(/_/g, ' ');
  const src = (f) => (embed
    ? `data:image/png;base64,${fs.readFileSync(path.join(framesDir, f)).toString('base64')}`
    : `frames/${f}`);
  const html = `<title>${job.name} frames</title>
<style>
  :root { --bg:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --line:#e1e0d9; --accent:#2a78d6; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --line:#2c2c2a; --accent:#3987e5; } }
  :root[data-theme="dark"] { --bg:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --line:#2c2c2a; --accent:#3987e5; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1000px; margin:0 auto; padding:24px 20px 48px;
         display:flex; flex-direction:column; gap:14px; }
  h1 { font-size:19px; margin:0; }
  .sub { color:var(--ink2); font-size:13px; }
  .stage { border:1px solid var(--line); border-radius:8px; background:var(--bg);
           display:flex; align-items:center; justify-content:center; min-height:340px; overflow:hidden; }
  .stage img { max-width:100%; height:auto; display:block; }
  .bar { display:flex; align-items:center; gap:12px; }
  input[type=range] { flex:1; accent-color:var(--accent); }
  button { font:inherit; padding:5px 14px; border:1px solid var(--line);
           border-radius:6px; background:transparent; color:var(--ink); cursor:pointer; }
  button:hover { border-color:var(--accent); }
  .cap { font-variant-numeric:tabular-nums; color:var(--ink2); min-width:15ch; }
</style>
<main>
  <h1>${job.name} — build replay</h1>
  <div class="sub">job ${job.id} · ${files.length} frames captured during the run</div>
  <div class="stage"><img id="f" alt="captured frame"></div>
  <div class="bar">
    <button id="p">▶︎ play</button>
    <input type="range" id="s" min="0" max="${files.length - 1}" value="0" step="1">
    <span class="cap" id="c"></span>
  </div>
</main>
<script>
const FRAMES = ${JSON.stringify(files.map((f) => ({ src: src(f), label: label(f) })))};
const img = document.getElementById('f'), sl = document.getElementById('s');
const cap = document.getElementById('c'), btn = document.getElementById('p');
let timer = null;
function show(i) {
  img.src = FRAMES[i].src;
  cap.textContent = (i + 1) + '/' + FRAMES.length + '  ' + FRAMES[i].label;
  sl.value = i;
}
function stop() { clearInterval(timer); timer = null; btn.textContent = '▶︎ play'; }
btn.onclick = () => {
  if (timer) return stop();
  btn.textContent = '❚❚ pause';
  timer = setInterval(() => {
    const next = (Number(sl.value) + 1) % FRAMES.length;
    show(next);
    if (next === FRAMES.length - 1) stop();
  }, 600);
};
sl.oninput = () => { stop(); show(Number(sl.value)); };
document.onkeydown = (e) => {
  if (e.key === 'ArrowRight') { stop(); show(Math.min(Number(sl.value) + 1, FRAMES.length - 1)); }
  if (e.key === 'ArrowLeft') { stop(); show(Math.max(Number(sl.value) - 1, 0)); }
};
show(0);
</script>
`;
  const out = path.join(dest, 'frames.html');
  fs.writeFileSync(out, html);
  const mb = (Buffer.byteLength(html) / 1048576).toFixed(1);
  banner('frames');
  console.log(`${files.length} frames → ${out}${embed ? `  (self-contained, ${mb} MB)` : ''}`);
  if (!embed) console.log('\x1b[2mimages referenced from ./frames/ — keep them alongside the html\x1b[0m');
  if (open) spawnSync('open', [out], { stdio: 'ignore' });
  else console.log(`\x1b[2mopen it with: open ${out}\x1b[0m`);
}

async function cancel(cfg, ref) {
  let id, label;
  if (ref && /^\d+$/.test(ref)) {
    id = ref;
    label = `job ${ref}`;
  } else {
    const job = findJob(ref);
    id = job.id;
    label = `job ${job.id} (${job.name})`;
  }
  await ensureMaster(cfg);
  run('ssh', [cfg.clusterHost, `scancel ${id}`]);
  console.log(`cancelled ${label}`);
}

async function shell(cfg) {
  await ensureMaster(cfg);
  spawnSync('ssh', [cfg.clusterHost], { stdio: 'inherit' });
}

// Wrap chosen [start,end) spans of a line in ANSI colors (zero visible width,
// so the sshare column alignment is preserved).
function colorSpans(line, spans) {
  let out = '';
  let pos = 0;
  for (const s of spans.sort((a, b) => a.start - b.start)) {
    out += line.slice(pos, s.start) + `\x1b[${s.code}m` + line.slice(s.start, s.end) + '\x1b[0m';
    pos = s.end;
  }
  return out + line.slice(pos);
}

const GREEN = '32', YELLOW = '33', RED = '31', DIM = '2', BOLD = '1';

// Continuous red→green ramp. Colour functions return the SGR *parameters*
// (not a full escape) so they still compose with `\x1b[1;${code}m` and colorSpans.
const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');
const CUBE = [0, 95, 135, 175, 215, 255]; // xterm-256 colour-cube levels

function rgbCode(r, g, b) {
  if (TRUECOLOR) return `38;2;${r};${g};${b}`;
  const q = (v) => CUBE.reduce((best, lvl, i) => (Math.abs(lvl - v) < Math.abs(CUBE[best] - v) ? i : best), 0);
  return `38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}`;
}

// Anchors from the status palette: critical → serious → warning → lime → good.
const RAMP = [[208, 59, 59], [236, 131, 90], [250, 178, 25], [154, 180, 20], [12, 163, 12]];

/** t = 0 → red, 1 → green. */
function ramp(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2);
  const f = x - i;
  const [r, g, b] = [0, 1, 2].map((k) => Math.round(RAMP[i][k] + f * (RAMP[i + 1][k] - RAMP[i][k])));
  return rgbCode(r, g, b);
}

/**
 * Usage colour, scaled against an EQUAL SHARE of the lab rather than an
 * arbitrary cutoff: at 1× your equal slice you sit mid-ramp, at 2× or more
 * you are full red. Usage is heavily skewed, so absolute thresholds would
 * paint almost everyone the same colour and say nothing.
 */
function usageColor(fraction, members = 8) {
  if (!fraction) return DIM;
  const ratio = fraction * Math.max(1, members); // 1.0 == exactly an equal share
  return ramp(1 - Math.min(1, ratio / 2));
}

/** Slurm fairshare: 0.5 is neutral by definition, so the ramp maps straight on. */
function fairshareColor(score) {
  return ramp(score);
}

/**
 * Colour key: gradient blocks with end labels. `reverse` draws green→red, for
 * scales where LOW is good (usage) as opposed to high (fairshare). Drawing both
 * keys in the same direction would mislabel one of them.
 */
function rampLegend(left, right, { reverse = false, steps = 12 } = {}) {
  const bar = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return `\x1b[${ramp(reverse ? 1 - t : t)}m█\x1b[0m`;
  }).join('');
  return `\x1b[2m${left.padStart(13)}\x1b[0m ${bar} \x1b[2m${right}\x1b[0m`;
}

async function fairshare(cfg, labArg) {
  await ensureMaster(cfg);

  const shareCmd = (acct) =>
    `sshare -A "${acct}" -a --format=Account%14,User%12,RawShares,NormShares,RawUsage,EffectvUsage,FairShare`;
  // The account-level row (Account set, User blank → 5 fields) carries the lab totals.
  const accountRow = (text) => text.split('\n').map((l) => l.trim().split(/\s+/))
    .find((t) => t.length === 5 && /^\d+$/.test(t[3]));

  let acct = labArg;
  if (!acct) {
    acct = run('ssh', [cfg.clusterHost, 'sacctmgr -n show assoc user=$(whoami) format=account%30'])
      .trim().split(/\s+/)[0];
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(acct || '')) die(`invalid account name "${acct}"`);

  let out = run('ssh', [cfg.clusterHost, shareCmd(acct)]);
  if (!accountRow(out) && !acct.endsWith('_lab')) {
    const retry = run('ssh', [cfg.clusterHost, shareCmd(`${acct}_lab`)]);
    if (accountRow(retry)) {
      acct = `${acct}_lab`;
      out = retry;
    }
  }
  const acctTokens = accountRow(out);
  if (!acctTokens) die(`no account "${labArg || acct}" on the cluster (list them with: cluster fs labs)`);

  const me = (spawnSync('ssh', ['-G', cfg.clusterHost], { encoding: 'utf8' }).stdout.match(/^user (\S+)$/m) || [])[1];
  const labTotal = Number(acctTokens[3]);
  const labScore = Number(acctTokens[2]) > 0 ? 2 ** (-(Number(acctTokens[4]) / Number(acctTokens[2]))) : null;

  let header = null;
  let dashes = null;
  let totalLine = null;
  let userColEnd = null;
  const members = [];
  for (const line of out.replace(/\n+$/, '').split('\n')) {
    const toks = [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
    const words = toks.map((t) => t.text);
    if (words[0] === 'Account') {
      header = line;
      userColEnd = toks[words.indexOf('User')]?.end ?? null;
    } else if (/^-+$/.test(words[0] || '')) {
      dashes = line;
    } else if (words.length === 5 && /^\d+$/.test(words[3])) {
      totalLine = line; // account-level row: shown as TOTAL at the bottom
    } else if (words.length === 7 && words[2] === 'parent') {
      members.push({ line, toks, words, usage: Number(words[4]) });
    }
  }
  members.sort((a, b) => b.usage - a.usage);
  // A user can hold several associations (partitions/QOS); show each person once, highest-usage row.
  const seen = new Set();
  const ranked = members.filter((m) => !seen.has(m.words[1]) && seen.add(m.words[1]));

  const view = [];
  view.push(bannerText(acct.replace(/_lab$/, '').replace(/_/g, ' '), labScore === null ? DIM : fairshareColor(labScore)));
  if (labScore !== null) view.push(`\x1b[2mlab fairshare: ${labScore.toFixed(3)}\x1b[0m`, '');

  const pad = '     '; // width of the "NNN. " rank prefix, keeps columns aligned
  if (header) view.push(`\x1b[2m${pad}${header}\x1b[0m`);
  if (dashes) view.push(`\x1b[2m${pad}${dashes}\x1b[0m`);
  ranked.forEach((m, i) => {
    const spans = [];
    if (!Number.isNaN(m.usage) && labTotal > 0) {
      spans.push({ start: m.toks[4].start, end: m.toks[4].end,
        code: usageColor(m.usage / labTotal, ranked.length) });
    }
    const score = Number(m.words[6]);
    if (!Number.isNaN(score)) {
      spans.push({ start: m.toks[6].start, end: m.toks[6].end, code: fairshareColor(score) });
    }
    if (m.words[1] === me) spans.push({ start: m.toks[1].start, end: m.toks[1].end, code: BOLD });
    view.push(`\x1b[2m${String(i + 1).padStart(3)}.\x1b[0m ` + colorSpans(m.line, spans));
  });
  if (totalLine) {
    if (userColEnd && userColEnd <= totalLine.length) {
      totalLine = totalLine.slice(0, userColEnd - 5) + 'TOTAL' + totalLine.slice(userColEnd);
    }
    if (dashes) view.push(`\x1b[2m${pad}${dashes}\x1b[0m`);
    view.push(`\x1b[1m${pad}${totalLine}\x1b[0m`);
  }

  view.push(
    '',
    `  ${rampLegend('light \u00b7 healthy', 'heavy \u00b7 over budget', { reverse: true })}`,
    '\x1b[2m  RawUsage is judged against an equal share of the lab; FairShare 0.5 = neutral.\x1b[0m',
    '\x1b[2m  Usage decays with a 3-day half-life; jobs bill allocated CPUs + memory (~1 core per 4 GB).\x1b[0m'
  );
  page(view.join('\n'));
}

async function fairshareLabs(cfg, topN) {
  await ensureMaster(cfg);
  const myAcct = run('ssh', [cfg.clusterHost, 'sacctmgr -n show assoc user=$(whoami) format=account%30'])
    .trim().split(/\s+/)[0];
  const raw = run('ssh', [cfg.clusterHost,
    "sshare -a -n --format=Account%30,User%12,RawShares,NormShares,RawUsage,EffectvUsage | awk 'NF==5'"]);

  const labs = raw.trim().split('\n')
    .map((l) => {
      const t = l.trim().split(/\s+/);
      return { name: t[0], norm: Number(t[2]), usage: Number(t[3]), eff: Number(t[4]) };
    })
    .filter((x) => x.name && !Number.isNaN(x.usage))
    .sort((a, b) => b.usage - a.usage);

  const view = [bannerText('all harvard labs', '34'), ''];

  const fmtRow = (rank, lab) => {
    const score = lab.norm > 0 ? 2 ** (-(lab.eff / lab.norm)) : null;
    const scoreStr = score === null ? '     —' : score.toFixed(3).padStart(6);
    const colored = score === null ? scoreStr : `\x1b[${fairshareColor(score)}m${scoreStr}\x1b[0m`;
    const line =
      String(rank).padStart(4) + '  ' +
      lab.name.padEnd(30) +
      Math.round(lab.usage / 3600).toLocaleString('en-US').padStart(14) + '  ' +
      (lab.eff * 100).toFixed(3).padStart(8) + '  ' +
      (lab.norm * 100).toFixed(3).padStart(7) + '  ' +
      colored;
    return lab.name === myAcct ? `\x1b[1m${line}\x1b[0m` : line;
  };

  view.push(`\x1b[2m${'rank'.padStart(4)}  ${'account'.padEnd(30)}${'usage (TRES-hr)'.padStart(14)}  ${'% used'.padStart(8)}  ${'% grant'.padStart(7)}  fairshare\x1b[0m`);
  labs.slice(0, topN).forEach((lab, i) => view.push(fmtRow(i + 1, lab)));

  const myRank = labs.findIndex((l) => l.name === myAcct);
  if (myRank >= topN) {
    view.push('\x1b[2m   …\x1b[0m');
    view.push(fmtRow(myRank + 1, labs[myRank]));
  }

  view.push('', `  ${rampLegend('light \u00b7 healthy', 'heavy \u00b7 over budget', { reverse: true })}`,
    `\x1b[2m  ${labs.length} lab accounts ranked by decayed usage; fairshare = 2^(\u2212%used/%grant), 0.5 = neutral.\x1b[0m`);
  page(view.join('\n'));
}

function logout(cfg) {
  if (!masterAlive(cfg)) {
    console.log('no active session.');
    return;
  }
  spawnSync('ssh', ['-O', 'exit', cfg.clusterHost], { stdio: 'ignore' });
  console.log('session closed — the next cluster command will log in again.');
}

// ---------- setup ----------

async function askHidden(rl, question) {
  spawnSync('stty', ['-echo'], { stdio: 'inherit' });
  const v = await rl.question(question);
  spawnSync('stty', ['echo'], { stdio: 'inherit' });
  process.stdout.write('\n');
  return v.trim();
}

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '';

  console.log('clt setup — config is written to ~/.config/clt/, secrets go to the macOS Keychain.\n');

  const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const cfg = { ...DEFAULT_CONFIG, ...existing, slurm: { ...DEFAULT_CONFIG.slurm, ...existing.slurm } };

  cfg.clusterHost = await ask('SSH host alias for the cluster (from ~/.ssh/config)', cfg.clusterHost);
  cfg.windowsHost = await ask('SSH host alias for the Windows machine', cfg.windowsHost);
  cfg.windowsFolder = await ask('COMSOL folder on Windows (relative to your user profile)', cfg.windowsFolder);
  cfg.comsolModule = await ask('COMSOL module on the cluster (`module avail comsol`)', cfg.comsolModule);
  cfg.slurm.partition = await ask('Slurm partition', cfg.slurm.partition);
  cfg.slurm.cpus = Number(await ask('CPUs per job', String(cfg.slurm.cpus)));
  cfg.slurm.mem = await ask('Memory per job', cfg.slurm.mem);
  cfg.slurm.time = await ask('Time limit', cfg.slurm.time);
  cfg.slurm.email = await ask('Email for job-completion notices (blank for none)', cfg.slurm.email);

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`\nwrote ${CONFIG_PATH}`);

  const pw = await askHidden(rl, '\nCluster (FASRC) password (stored in Keychain, blank to keep existing): ');
  if (pw) keychainSet(KEYCHAIN_PASSWORD, pw);

  const seed = await askHidden(rl, 'OpenAuth TOTP secret, base32 (blank to keep existing): ');
  if (seed) keychainSet(KEYCHAIN_TOTP, seed);

  rl.close();

  try {
    const code = totp(keychainGet(KEYCHAIN_TOTP));
    console.log(`\nCurrent OTP from stored secret: ${code}`);
    console.log('Open your OpenAuth/JAuth app and confirm it shows the SAME code.');
    console.log('If it differs, the secret is wrong — rerun `cluster setup`.');
  } catch {
    console.log('\n(no TOTP secret stored yet)');
  }
  console.log('\nNext: make sure the ssh config blocks from README.md are in place, then try `cluster login`.');
}

// ---------- main ----------

function usage() {
  console.log(`usage:
  cluster <file.mph> [comsol args]   fetch from Windows if needed, upload, run async via sbatch
  cluster time <file.mph> [args]     probe-run to estimate runtime + memory (--minutes N, -study stdN)
  cluster jobs [--all]               every job this tool submitted, with its final state
  cluster status [jobid]             queue overview, or details for one job (--json for pollers)
  cluster logs [name|jobid]          tail the COMSOL batch log (default: latest job)
  cluster watch [name|jobid]         live progress + scrollable log (--points N for a sweep's
                                     overall bar and ETA; default: latest job)
  cluster fetch [name|jobid]         download out.mph + batch.log (default: latest job)
  cluster frames [name|jobid]        replay a run's captured frames (--embed, --open)
  cluster cancel [name|jobid]        stop a running/queued job (default: latest job)
  cluster fs [lab]                   a lab's score + members ranked by usage (default: your lab)
  cluster fs labs [N]                all labs on the cluster ranked by usage (default top 20)
  cluster shell                      interactive shell on the cluster (reuses session)
  cluster login                      just establish the shared ssh session
  cluster logout                     close the shared ssh session now
  cluster code                       print the current 2FA code (for manual logins)
  cluster eff [name|jobid]           what a finished job actually used, and how to right-size
  cluster report [name|jobid]        write RUN_NOTES.md for a run: config, usage, errors
  cluster lessons                    accumulated notes on using this tool well
  cluster load [partition]           live cluster utilisation and a node-state mosaic
  cluster seats [--all]              COMSOL licence seats in use across SEAS (--refresh)
  cluster doctor                     check every setup step and name what is broken
  cluster setup                      interactive first-time / reconfiguration`);
  process.exit(0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || ['help', '-h', '--help'].includes(cmd)) usage();
  if (cmd === 'setup') return setup();
  if (cmd === 'doctor') return doctor();
  if (cmd === 'code') {
    console.log(`${totp(keychainGet(KEYCHAIN_TOTP))}  (${totpSecondsRemaining()}s left)`);
    return;
  }

  const cfg = loadConfig();
  switch (cmd) {
    case 'time':   return timeProbe(cfg, rest);
    case 'jobs':   return jobsList(cfg, rest);
    case 'eff':    return eff(cfg, rest);
    case 'report': return report(cfg, rest);
    case 'lessons': return lessons();
    case 'load':   return load(cfg, rest);
    case 'licenses':
    case 'seats':  return licenses(cfg, rest);
    case 'status': return rest.includes('--json') ? statusJson(cfg) : status(cfg, rest[0]);
    case 'logs':   return logs(cfg, rest[0]);
    case 'watch': {
      const i = rest.indexOf('--points');
      const n = i === -1 ? null : Number(rest[i + 1]) || null;
      return watch(cfg, rest.filter((a, k) => k !== i && k !== i + 1)[0], n);
    }
    case 'fetch':  return fetch(cfg, rest[0]);
    case 'frames': return frames(cfg, rest);
    case 'cancel': return cancel(cfg, rest[0]);
    case 'fs':
    case 'fairshare':
      return rest[0] === 'labs' ? fairshareLabs(cfg, Number(rest[1]) || 20) : fairshare(cfg, rest[0]);
    case 'shell':  return shell(cfg);
    case 'login':  return ensureMaster(cfg).then(() => banner('ready'));
    case 'logout': return logout(cfg);
    default:       return submit(cfg, cmd, rest);
  }
}

function cli() {
  main().catch((e) => die(e.message));
}

module.exports = {
  cli, main,
  loadConfig, loadJobs, recordJob, findJob,
  run, keychainGet, totp, totpSecondsRemaining,
  masterAlive, ensureMaster, touchIdGate,
  stageInputFile, sbatchScript, submit, timeProbe,
  doctor, eff, effStatus, load, report, runReport, lessons, readLessons, recordLesson, licenses, licenseStatus, jobsList, status, statusJson, logs, fetch, frames, cancel, shell, logout,
  fairshare, fairshareLabs,
  slurmSeconds, slurmTime, recommendMem, etaParts, easternFinish, fmtDur,
  banner, bannerText, ramp, rampLegend,
};

if (require.main === module) cli();
