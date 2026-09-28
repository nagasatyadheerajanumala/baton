import type { ToolCallBlock, ToolSpec } from '../ir/types.js';
import type { ProcessManager } from './processes.js';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /**
   * Ask the user before a side-effecting action. Resolves false to deny.
   * The tool engine calls this; tools never prompt directly.
   */
  approve: (summary: string, call?: ToolCallBlock) => Promise<boolean>;
  /** Shell commands the tools start; shown in the TUI process pane. */
  processes: ProcessManager;
  /** Plan mode: anything that changes something is refused, for every provider. */
  planMode?: () => boolean;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /** Side-effecting tools go through ctx.approve() before execute(). */
  mutates: boolean;
  /** One-line description of this specific call, for approval prompts and logs. */
  describe(input: Record<string, unknown>): string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolInputError extends Error {}

export function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key];
  if (typeof v === 'string') return v;
  if (v === undefined && !required) return '';
  throw new ToolInputError(`"${key}" must be a string`);
}

export function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  throw new ToolInputError(`"${key}" must be a number`);
}
