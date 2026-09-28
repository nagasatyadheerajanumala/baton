import Anthropic from '@anthropic-ai/sdk';
import { type AssistantTurn, type ContentBlock, type Message, type StopReason, type ToolSpec, reasoningOrigin } from '../ir/types.js';
import { type CompletionRequest, type ProviderAdapter, sanitizeToolId } from './types.js';

const PROTOCOL = 'anthropic';

export interface AnthropicAdapterOptions {
  name: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name: string;
  readonly label = 'Claude API';
  private readonly client: Anthropic;

  constructor(opts: AnthropicAdapterOptions) {
    this.name = opts.name;
    // maxRetries: 0 — the router owns retry/failover policy, not the SDK.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, defaultHeaders: opts.headers, maxRetries: 0 });
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(req.messages, req.model),
        tools: req.tools.map(toAnthropicTool),
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on('text', req.onText);
    const final = await stream.finalMessage();
    return {
      content: fromAnthropicContent(final.content, req.model),
      stopReason: mapStop(final.stop_reason),
      usage: anthropicUsage(final.usage),
    };
  }
}

// ---- Pure translations (exported for tests) --------------------------------

/**
 * @param model the model being called; thinking blocks are only replayed to
 *   the exact model that produced them (signatures are model-bound).
 */
export function toAnthropicMessages(messages: Message[], model = ''): Anthropic.MessageParam[] {
  const origin = reasoningOrigin(PROTOCOL, model);
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const blocks = m.content
      .map((b) => toAnthropicBlock(b, origin))
      .filter((b): b is Anthropic.ContentBlockParam => b !== null);
    if (blocks.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && Array.isArray(prev.content)) {
      prev.content.push(...blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }
  // Tool results must lead their user message.
  for (const m of out) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
  }
  // Cache breakpoint on the newest block so the growing prefix is reused turn to turn.
  const last = out[out.length - 1];
  if (last && Array.isArray(last.content)) {
    const tail = last.content[last.content.length - 1];
    if (tail && (tail.type === 'text' || tail.type === 'tool_result')) {
      tail.cache_control = { type: 'ephemeral' };
    }
  }
  return out;
}

function toAnthropicBlock(b: ContentBlock, origin: string): Anthropic.ContentBlockParam | null {
  switch (b.type) {
    case 'reasoning':
      return b.origin === origin ? (b.data as Anthropic.ContentBlockParam) : null;
    case 'text':
      return b.text.trim() ? { type: 'text', text: b.text } : null;
    case 'tool_call':
      return { type: 'tool_use', id: sanitizeToolId(b.id), name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: sanitizeToolId(b.callId),
        content: b.content || '(no output)',
        ...(b.isError ? { is_error: true } : {}),
      };
  }
}

export function fromAnthropicContent(content: Anthropic.ContentBlock[], model = ''): ContentBlock[] {
  const origin = reasoningOrigin(PROTOCOL, model);
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      out.push({ type: 'tool_call', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    } else if (b.type === 'thinking') {
      // Claude 5.x thinks by default; the API requires these back, unmodified, within a tool loop.
      out.push({ type: 'reasoning', origin, data: { type: 'thinking', thinking: b.thinking, signature: b.signature } });
    } else if (b.type === 'redacted_thinking') {
      out.push({ type: 'reasoning', origin, data: { type: 'redacted_thinking', data: b.data } });
    }
    // Server-tool blocks are not used by baton.
  }
  return out;
}

function toAnthropicTool(t: ToolSpec): Anthropic.Tool {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

function mapStop(r: string | null): StopReason {
  if (r === 'end_turn' || r === 'stop_sequence') return 'end_turn';
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  return 'other';
}

/** Anthropic reports uncached input separately from cache reads/writes; normalize to totals. */
export function anthropicUsage(u: Anthropic.Usage): AssistantTurn['usage'] {
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return { inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cachedInputTokens: cacheRead };
}
