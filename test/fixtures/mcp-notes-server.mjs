// Minimal real MCP server (stdio) for tests, built on the official SDK.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'write_note', description: 'Append a note to notes.txt.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
  if (req.params.name === 'write_note') {
    appendFileSync('notes.txt', `${args.note}\n`);
    return { content: [{ type: 'text', text: 'saved' }] };
  }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});
await server.connect(new StdioServerTransport());
