// End-to-end smoke test: drives the MCP server exactly like a client would —
// handshake, tool list, then the full loop: submit HelloBox via run_code,
// poll to completion, fetch the CSV, check fairshare.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const parse = (r) => JSON.parse(r.content[0].text);

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'mcp', 'server.mjs')],
  stderr: 'inherit',
});
const client = new Client({ name: 'clt-smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const status = parse(await client.callTool({ name: 'job_status', arguments: {} }));
console.log('ACTIVE JOBS:', status.active.length);

const java = fs.readFileSync(path.join(root, 'references', 'HelloBox.java'), 'utf8');
const sub = parse(await client.callTool({ name: 'run_code', arguments: { java_source: java, label: 'mcp-smoke', hours: 0.5 } }));
if (sub.error) throw new Error(`run_code failed: ${sub.error}`);
console.log('SUBMITTED:', sub.job_id, sub.remote_dir);

let final = null;
for (let i = 0; i < 30; i++) {
  const w = parse(await client.callTool({ name: 'wait_for_job', arguments: { job_id: sub.job_id, timeout_s: 60 } }));
  console.log('  poll:', w.state, w.elapsed ?? '');
  if (w.finished) { final = w; break; }
}
if (!final || final.state !== 'COMPLETED') {
  const log = parse(await client.callTool({ name: 'job_log', arguments: { job_id: sub.job_id } }));
  console.log('LOG TAIL:', (log.batch_log || '').slice(-600));
  throw new Error(`job ended ${final ? final.state : 'never'}`);
}

const art = parse(await client.callTool({ name: 'fetch_artifacts', arguments: { job_id: sub.job_id } }));
console.log('ARTIFACTS:', art.files);
const csv = art.files.find((f) => f.endsWith('eigenfrequencies.csv'));
const firstMode = fs.readFileSync(csv, 'utf8').split('\n').map((l) => parseFloat(l)).filter((v) => v > 1)[0];
console.log('FIRST NONZERO MODE:', firstMode, '(analytic 171.5) →', Math.abs(firstMode - 171.5) < 0.5 ? 'MATCH' : 'MISMATCH');

const fsr = parse(await client.callTool({ name: 'lab_fairshare', arguments: {} }));
console.log('FAIRSHARE:', fsr.account, fsr.fairshare, fsr.healthy ? '(healthy)' : '(over budget)');

await client.close();
console.log('SMOKE TEST PASSED');
