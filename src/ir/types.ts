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

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

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
  inputTokens: number;
  outputTokens: number;
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
