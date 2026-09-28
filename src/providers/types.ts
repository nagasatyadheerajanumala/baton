import type { AssistantTurn, Message, ToolSpec } from '../ir/types.js';

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Streamed text deltas, for live terminal output. */
  onText?: (delta: string) => void;
}

/**
 * A provider adapter owns exactly two translations: IR -> vendor request, and
 * vendor response -> IR. It must throw raw SDK errors untouched; classification
 * into failover decisions happens in router/errors.ts.
 */
export interface ProviderAdapter {
  /** Instance name from config, e.g. "anthropic", "openrouter", "ollama". */
  readonly name: string;
  complete(req: CompletionRequest): Promise<AssistantTurn>;
}

/**
 * Tool call ids cross providers, so they must satisfy the strictest format.
 * Anthropic requires ^[a-zA-Z0-9_-]+$; some OpenAI-compatible servers emit ids
 * with other characters. Mapping is deterministic so call/result pairs agree.
 */
export function sanitizeToolId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.length > 0 ? clean.slice(0, 64) : 'call_empty';
}
