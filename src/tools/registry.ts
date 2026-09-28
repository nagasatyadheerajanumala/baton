import type { ToolCallBlock, ToolResultBlock, ToolSpec } from '../ir/types.js';
import { editFileTool, listFilesTool, readFileTool, searchTool, writeFileTool } from './fs.js';
import { bashTool, gitStatusTool, processKillTool, processListTool, processOutputTool, skillTool } from './shell.js';
import { isReadOnlyCommand } from './readonly.js';
import { type Tool, type ToolContext, ToolInputError } from './types.js';

export const DEFAULT_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  searchTool,
  bashTool,
  processOutputTool,
  processKillTool,
  processListTool,
  gitStatusTool,
  skillTool,
];

/**
 * Vendor-agnostic tool engine. Takes IR tool calls, returns IR tool results.
 * Never throws for tool-level failures: every error becomes an `isError`
 * result the model can read and recover from.
 */
export class ToolEngine {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = DEFAULT_TOOLS) {
    for (const t of tools) this.tools.set(t.spec.name, t);
  }

  get specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /** Replace the MCP-provided tools (servers connect in the background and can change). */
  setMcpTools(tools: Tool[]): void {
    for (const name of [...this.tools.keys()]) if (name.startsWith('mcp__')) this.tools.delete(name);
    for (const t of tools) this.tools.set(t.spec.name, t);
  }

  describe(call: ToolCallBlock): string {
    return this.tools.get(call.name)?.describe(call.input) ?? call.name;
  }

  async run(call: ToolCallBlock, ctx: ToolContext): Promise<ToolResultBlock> {
    const result = (content: string, isError = false): ToolResultBlock => ({
      type: 'tool_result',
      callId: call.id,
      content,
      ...(isError ? { isError: true } : {}),
    });

    const tool = this.tools.get(call.name);
    if (!tool) return result(`Unknown tool "${call.name}". Available: ${[...this.tools.keys()].join(', ')}`, true);
    if ('__unparsed_arguments' in call.input) {
      return result(`Arguments were not valid JSON: ${String(call.input.__unparsed_arguments).slice(0, 500)}`, true);
    }
    const missing = (tool.spec.inputSchema.required ?? []).filter((k) => call.input[k] === undefined);
    if (missing.length) return result(`Missing required argument(s): ${missing.join(', ')}`, true);

    if (tool.mutates && !needsNoApproval(call) && ctx.planMode?.()) {
      return result(PLAN_MODE_REFUSAL, true);
    }
    const pre = ctx.hooks ? await ctx.hooks.preToolUse(call) : undefined;
    if (pre?.block) return result(`A hook blocked this ${call.name} call: ${pre.block}`, true);
    if (tool.mutates && !needsNoApproval(call) && !pre?.allow && !(await ctx.approve(tool.describe(call.input), call))) {
      return result('The user denied this action. Ask them how to proceed or try a different approach.', true);
    }

    try {
      const out = await tool.execute(call.input, ctx);
      const done = result(out.content, out.isError);
      const post = ctx.hooks ? await ctx.hooks.postToolUse(call, done) : undefined;
      const feedback = [post?.block, ...(post?.context ?? [])].filter(Boolean);
      return feedback.length ? { ...done, content: `${done.content}\n\n[hook feedback] ${feedback.join('\n')}` } : done;
    } catch (err) {
      if (err instanceof ToolInputError) return result(`Invalid input: ${err.message}`, true);
      const e = err as NodeJS.ErrnoException;
      if (e.name === 'AbortError' || ctx.signal?.aborted) return result('Interrupted by the user.', true);
      return result(`${e.code ? `${e.code}: ` : ''}${e.message ?? String(err)}`, true);
    }
  }
}

/** Read-only shell commands (git status, ls, rg, ...) run without a prompt, like other coding agents. */
export function needsNoApproval(call: ToolCallBlock): boolean {
  return call.name === 'bash' && call.input.background !== true && typeof call.input.command === 'string' && isReadOnlyCommand(call.input.command);
}

export const PLAN_MODE_REFUSAL =
  'Plan mode is on, so nothing may be changed yet. Keep investigating with read-only tools (reading files, searching, read-only shell commands), then present a concise step-by-step plan and stop. The user will switch modes to let you implement it.';
