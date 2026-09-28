/** Local HTTP server speaking OpenAI (Chat + Responses) and Anthropic wire formats. */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

export class FakeProviders {
  readonly bodies: { path: string; body: Record<string, unknown> }[] = [];
  private readonly queues = new Map<string, Handler[]>();
  private readonly server = createServer((req, res) => void this.handle(req, res));
  base = '';

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
  on(path: string, ...handlers: Handler[]): void {
    this.queues.set(path, [...(this.queues.get(path) ?? []), ...handlers]);
  }
  requestsTo(path: string) {
    return this.bodies.filter((b) => b.path === path).map((b) => b.body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = req.url!.split('?')[0]!;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.bodies.push({ path, body });
    const next = this.queues.get(path)?.shift();
    if (!next) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `unexpected ${path}` } }));
    else next(body, res);
  }
}

export function sse(res: ServerResponse, events: Array<[string | null, unknown]>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  res.end();
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

// ---- Anthropic ----------------------------------------------------------------

export type AnthropicBlock = { start: object; deltas: object[] };

export function anthropicStream(res: ServerResponse, blocks: AnthropicBlock[], stop: string, model = 'claude-test') {
  sse(res, [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } }],
    ...blocks.flatMap((b, index): Array<[string, unknown]> => [
      ['content_block_start', { type: 'content_block_start', index, content_block: b.start }],
      ...b.deltas.map((delta): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index, delta }]),
      ['content_block_stop', { type: 'content_block_stop', index }],
    ]),
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 17 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

export const aThinking = (signature: string): AnthropicBlock => ({
  start: { type: 'thinking', thinking: '', signature: '' },
  deltas: [{ type: 'thinking_delta', thinking: '' }, { type: 'signature_delta', signature }],
});
export const aToolUse = (id: string, name: string, input: object): AnthropicBlock => ({
  start: { type: 'tool_use', id, name, input: {} },
  deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }],
});
export const aText = (text: string): AnthropicBlock => ({ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text }] });

// ---- OpenAI Responses -----------------------------------------------------------

export function responsesStream(res: ServerResponse, output: object[], opts: { text?: string; status?: string } = {}) {
  const response = {
    id: 'resp_1', object: 'response', created_at: 0, status: opts.status ?? 'completed', model: 'gpt-test',
    output, error: null, incomplete_details: null,
    usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } },
  };
  sse(res, [
    ['response.created', { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } }],
    ...(opts.text ? [['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: opts.text }] as [string, unknown]] : []),
    ['response.completed', { type: 'response.completed', sequence_number: 2, response }],
  ]);
}

export const rReasoning = (id: string, encrypted: string) => ({ type: 'reasoning', id, summary: [], encrypted_content: encrypted });
export const rCall = (callId: string, name: string, args: object) => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' });
export const rMessage = (text: string) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
