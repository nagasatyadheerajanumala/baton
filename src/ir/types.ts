/**
 * Intermediate Representation (IR) for conversations.
 *
 * Every provider adapter translates to and from this shape; nothing outside
 * `src/providers/` should ever see a vendor-specific message format.
 *
 * Invariants (enforced by `settle()` in ./session.ts):
 *  - Messages alternate by role only loosely; adapters merge as needed.
 *  - Every `tool_call` in an assistant message is answered by exactly one
 *    `tool_result` (matching `callId`) in the immediately following user message.
 *  - Assistant messages are committed only once complete. A response that dies
 *    mid-stream is discarded, never persisted, so a provider switch always
 *    happens on a settled boundary.
 */

export type Role = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  /** Provider-issued id, kept verbatim. Adapters sanitize on the way out. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  callId: string;
  content: string;
  isError?: boolean;
}

/**
 * Opaque, model-bound reasoning state (Anthropic `thinking`/`redacted_thinking`
 * blocks with signatures, OpenAI Responses `reasoning` items with
 * encrypted_content). Both vendors require these to be sent back unchanged
 * within a tool-use loop, or reasoning is silently dropped mid-task.
 *
 * Only the adapter whose `origin` matches may emit it; every other adapter
 * skips it. That is what makes cross-provider switches safe: the new model
 * never sees another model's encrypted reasoning.
 */
export interface ReasoningBlock {
  type: 'reasoning';
  /** `${protocol}:${model}`, e.g. "anthropic:claude-opus-5-5". */
  origin: string;
  /** The vendor's raw block/item, round-tripped verbatim. */
  data: unknown;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock;

export interface MessageMeta {
  /** Which provider/model produced an assistant message. */
  provider?: string;
  model?: string;
  ts: number;
  usage?: Usage;
  /** Set by compaction when this message is synthesized, not original. */
  synthetic?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  meta: MessageMeta;
}

export interface Usage {
  /** All input tokens, including any served from the provider's prompt cache. */
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens read from cache (billed at a discount). */
  cachedInputTokens?: number;
}

/** Vendor-neutral tool definition (JSON Schema input). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

/** A complete assistant turn returned by an adapter. */
export interface AssistantTurn {
  content: ContentBlock[];
  stopReason: StopReason;
  usage?: Usage;
}

export const isToolCall = (b: ContentBlock): b is ToolCallBlock => b.type === 'tool_call';
export const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === 'tool_result';
export const isText = (b: ContentBlock): b is TextBlock => b.type === 'text';
export const isReasoning = (b: ContentBlock): b is ReasoningBlock => b.type === 'reasoning';

export const reasoningOrigin = (protocol: string, model: string) => `${protocol}:${model}`;
