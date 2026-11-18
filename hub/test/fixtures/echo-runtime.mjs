// Tiny MCP stdio runtime for pool tests. Tools report the process environment and working
// directory, write and list files in the state directory, wait, or exit.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const stateDir = () => process.env.ECHO_STATE_DIR ?? process.cwd();
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const schema = { type: 'object', properties: {} };

const server = new Server({ name: 'echo-runtime', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ['env', 'write', 'list', 'sleep', 'exit'].map(name => ({ name, inputSchema: schema })),
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case 'env':
      return text({ pid: process.pid, cwd: process.cwd(), env: process.env });
    case 'write':
      writeFileSync(join(stateDir(), String(args.name)), String(args.content ?? ''));
      return text('written');
    case 'list':
      return text(readdirSync(stateDir()));
    case 'sleep':
      await new Promise(resolve => setTimeout(resolve, Number(args.ms ?? 0)));
      return text('slept');
    case 'exit':
      process.exit(3);
    default:
      return { ...text(`unknown tool ${request.params.name}`), isError: true };
  }
});
await server.connect(new StdioServerTransport());
