import Anthropic from '@anthropic-ai/sdk';
import type { AssistantTurn, ContentBlock, Message, StopReason, ToolSpec } from '../ir/types.js';
import { type CompletionRequest, type ProviderAdapter, sanitizeToolId } from './types.js';

export interface AnthropicAdapterOptions {
  name: string;
  apiKey?: string;
  baseURL?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(opts: AnthropicAdapterOptions) {
    this.name = opts.name;
    // maxRetries: 0 — the router owns retry/failover policy, not the SDK.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map(toAnthropicTool),
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on('text', req.onText);
    const final = await stream.finalMessage();
    return {
      content: fromAnthropicContent(final.content),
      stopReason: mapStop(final.stop_reason),
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
    };
  }
}

// ---- Pure translations (exported for tests) --------------------------------

export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    const blocks = m.content.map(toAnthropicBlock).filter((b): b is Anthropic.ContentBlockParam => b !== null);
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

function toAnthropicBlock(b: ContentBlock): Anthropic.ContentBlockParam | null {
  switch (b.type) {
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

export function fromAnthropicContent(content: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') {
      out.push({ type: 'tool_call', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    // thinking / server-tool blocks are provider-bound and intentionally dropped.
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
