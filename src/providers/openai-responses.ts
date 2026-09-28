import OpenAI from 'openai';
import {
  type AssistantTurn,
  type ContentBlock,
  type Message,
  type StopReason,
  type ToolSpec,
  isReasoning,
  isText,
  isToolCall,
  isToolResult,
  reasoningOrigin,
} from '../ir/types.js';
import { type CompletionRequest, type ProviderAdapter, sanitizeToolId } from './types.js';

const PROTOCOL = 'openai-responses';

type InputItem = OpenAI.Responses.ResponseInputItem;

export interface OpenAIResponsesAdapterOptions {
  name: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  /** reasoning.effort; omit to use the model default. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * OpenAI Responses API adapter, for api.openai.com itself.
 *
 * Why not Chat Completions: current OpenAI reasoning models only support
 * function calling on Chat Completions with reasoning disabled. Responses keeps
 * reasoning on during tool use, provided we replay the encrypted reasoning
 * items. We run stateless (`store: false`) and carry that state in the IR,
 * so the session log stays the single source of truth and can hand off to
 * another provider at any turn.
 */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly client: OpenAI;
  private readonly effort: OpenAIResponsesAdapterOptions['reasoningEffort'];

  constructor(opts: OpenAIResponsesAdapterOptions) {
    this.name = opts.name;
    this.effort = opts.reasoningEffort;
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, defaultHeaders: opts.headers, maxRetries: 0 });
  }

  async complete(req: CompletionRequest): Promise<AssistantTurn> {
    const stream = await this.client.responses.create(
      {
        model: req.model,
        instructions: req.system,
        input: toResponsesInput(req.messages, req.model),
        tools: req.tools.map(toResponsesTool),
        max_output_tokens: req.maxTokens,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(this.effort ? { reasoning: { effort: this.effort } } : {}),
        stream: true,
      },
      { signal: req.signal },
    );

    let final: OpenAI.Responses.Response | undefined;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') req.onText?.(event.delta);
      else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
      else if (event.type === 'response.failed') throw responseError(event.response.error?.message ?? 'Response failed', event.response.error?.code);
      else if (event.type === 'error') throw responseError(event.message, event.code ?? undefined);
    }
    if (!final) throw new Error('Responses stream ended without a final response');
    return fromResponse(final, req.model);
  }
}

// ---- Pure translations (exported for tests) --------------------------------

export function toResponsesInput(messages: Message[], model = ''): InputItem[] {
  const origin = reasoningOrigin(PROTOCOL, model);
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      // Preserve block order: reasoning items must precede the calls they led to.
      let text = '';
      const flushText = () => {
        if (text.trim()) out.push({ role: 'assistant', content: text });
        text = '';
      };
      for (const b of m.content) {
        if (isText(b)) text += b.text;
        else if (isReasoning(b)) {
          if (b.origin !== origin) continue; // another model's encrypted reasoning is meaningless here
          flushText();
          out.push(b.data as OpenAI.Responses.ResponseReasoningItem);
        } else if (isToolCall(b)) {
          flushText();
          out.push({ type: 'function_call', call_id: sanitizeToolId(b.id), name: b.name, arguments: JSON.stringify(b.input) });
        }
      }
      flushText();
    } else {
      for (const r of m.content.filter(isToolResult)) {
        out.push({
          type: 'function_call_output',
          call_id: sanitizeToolId(r.callId),
          output: (r.isError ? 'ERROR: ' : '') + (r.content || '(no output)'),
        });
      }
      const text = m.content.filter(isText).map((b) => b.text).join('\n');
      if (text.trim()) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export function fromResponse(res: OpenAI.Responses.Response, model = ''): AssistantTurn {
  const origin = reasoningOrigin(PROTOCOL, model);
  const content: ContentBlock[] = [];
  for (const item of res.output) {
    if (item.type === 'message') {
      const text = item.content.map((c) => (c.type === 'output_text' ? c.text : '')).join('');
      if (text) content.push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_call', id: item.call_id, name: item.name, input: parseArgs(item.arguments) });
    } else if (item.type === 'reasoning') {
      content.push({
        type: 'reasoning',
        origin,
        data: { type: 'reasoning', id: item.id, summary: item.summary, encrypted_content: item.encrypted_content },
      });
    }
  }
  const hasCalls = content.some(isToolCall);
  const stopReason: StopReason = hasCalls
    ? 'tool_use'
    : res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens'
      ? 'max_tokens'
      : res.status === 'completed'
        ? 'end_turn'
        : 'other';
  return {
    content,
    stopReason,
    usage: res.usage
      ? {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cachedInputTokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
        }
      : undefined,
  };
}

function toResponsesTool(t: ToolSpec): OpenAI.Responses.FunctionTool {
  return { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { __unparsed_arguments: raw };
  }
}

/**
 * Errors inside the SSE stream arrive after a 200, so the SDK can't attach a
 * status. Give them one from the error code so the router classifies them.
 */
function responseError(message: string, code?: string): Error {
  const status =
    code === 'rate_limit_exceeded' ? 429
    : code === 'insufficient_quota' ? 429
    : code === 'context_length_exceeded' ? 400
    : code === 'server_error' || code === 'vector_store_timeout' ? 500
    : undefined;
  return Object.assign(new Error(message), { status, error: { code } });
}
