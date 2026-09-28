import OpenAI from 'openai';
import type { AssistantTurn, ContentBlock, Message, StopReason, ToolSpec } from '../ir/types.js';
import { isText, isToolCall, isToolResult } from '../ir/types.js';
import { type CompletionRequest, type ProviderAdapter, sanitizeToolId } from './types.js';

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface OpenAIAdapterOptions {
  name: string;
  apiKey?: string;
  /** Set for OpenRouter, LiteLLM, Ollama, or any OpenAI-compatible server. */
  baseURL?: string;
  /**
   * OpenAI's own API wants `max_completion_tokens`; many compatible servers
   * only understand `max_tokens`. Defaults based on whether baseURL is set.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  headers?: Record<string, string>;
}

/**
 * Chat Completions adapter. Deliberately not the Responses API: Chat
 * Completions is the lingua franca that OpenRouter, LiteLLM and Ollama all
 * speak, so this single adapter covers four provider slots.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';

  constructor(opts: OpenAIAdapterOptions) {
    this.name = opts.name;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? 'unused',
      baseURL: opts.baseURL,
      defaultHeaders: opts.headers,
      maxRetries: 0, // the router owns retry/failover policy
    });
    this.maxTokensParam = opts.maxTokensParam ?? (opts.baseURL ? 'max_tokens' : 'max_completion_tokens');
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: toOpenAIMessages(req.system, req.messages),
        tools: req.tools.length ? req.tools.map(toOpenAITool) : undefined,
        [this.maxTokensParam]: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    );

    const acc = new StreamAccumulator();
    for await (const chunk of stream) {
      const delta = acc.push(chunk);
      if (delta && req.onText) req.onText(delta);
    }
    return acc.finish();
  }
}

/** Reassembles streamed text and fragmented tool-call arguments. */
export class StreamAccumulator {
  private text = '';
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finishReason: string | null = null;
  private usage: AssistantTurn['usage'];

  /** Returns any new text delta for live display. */
  push(chunk: OpenAI.Chat.ChatCompletionChunk): string | undefined {
    if (chunk.usage) {
      this.usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    }
    const choice = chunk.choices[0];
    if (!choice) return undefined;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    for (const tc of choice.delta.tool_calls ?? []) {
      const cur = this.calls.get(tc.index) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      this.calls.set(tc.index, cur);
    }
    const delta = choice.delta.content ?? undefined;
    if (delta) this.text += delta;
    return delta;
  }

  finish(): AssistantTurn {
    const content: ContentBlock[] = [];
    if (this.text) content.push({ type: 'text', text: this.text });
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b);
    for (const [index, c] of ordered) {
      content.push({
        type: 'tool_call',
        id: c.id || `call_${index}_${Date.now()}`, // some local servers omit ids
        name: c.name,
        input: parseArgs(c.args),
      });
    }
    const hasCalls = content.some(isToolCall);
    return { content, stopReason: mapStop(this.finishReason, hasCalls), usage: this.usage };
  }
}

// ---- Pure translations (exported for tests) --------------------------------

export function toOpenAIMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter(isText).map((b) => b.text).join('');
      const calls = m.content.filter(isToolCall);
      if (!text && calls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: sanitizeToolId(c.id),
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else {
      // IR keeps tool results inside user messages (Anthropic-shaped);
      // OpenAI wants each as its own `tool` message, before any user text.
      for (const r of m.content.filter(isToolResult)) {
        out.push({
          role: 'tool',
          tool_call_id: sanitizeToolId(r.callId),
          content: (r.isError ? 'ERROR: ' : '') + (r.content || '(no output)'),
        });
      }
      const text = m.content.filter(isText).map((b) => b.text).join('\n');
      if (text.trim()) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

function toOpenAITool(t: ToolSpec): OpenAI.Chat.ChatCompletionFunctionTool {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    // Surface to the tool layer, which will return a validation error to the model.
    return { __unparsed_arguments: raw };
  }
}

function mapStop(r: string | null, hasCalls: boolean): StopReason {
  if (hasCalls || r === 'tool_calls') return 'tool_use';
  if (r === 'stop') return 'end_turn';
  if (r === 'length') return 'max_tokens';
  return 'other';
}
