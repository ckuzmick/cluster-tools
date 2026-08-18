// Generic one-shot MCP tool caller (debugging / scripting):
//   node mcp/call.mjs <tool> '<json-args>'
// String values starting with @ are replaced by that file's contents (repo-relative).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [tool, jsonArg] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node mcp/call.mjs <tool> ['{\"json\":\"args\"}']  (@file values are inlined)");
  process.exit(1);
}
const args = jsonArg ? JSON.parse(jsonArg) : {};
for (const [k, v] of Object.entries(args)) {
  if (typeof v === 'string' && v.startsWith('@')) args[k] = fs.readFileSync(path.resolve(root, v.slice(1)), 'utf8');
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'mcp', 'server.mjs')],
  stderr: 'inherit',
});
const client = new Client({ name: 'clt-call', version: '0.0.1' });
await client.connect(transport);
const res = await client.callTool({ name: tool, arguments: args });
console.log(res.content[0].text);
await client.close();
