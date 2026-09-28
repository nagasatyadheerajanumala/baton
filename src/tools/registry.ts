import type { ToolCallBlock, ToolResultBlock, ToolSpec } from '../ir/types.js';
import { editFileTool, listFilesTool, readFileTool, searchTool, writeFileTool } from './fs.js';
import { bashTool, gitStatusTool, processKillTool, processListTool, processOutputTool } from './shell.js';
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

    if (tool.mutates && !(await ctx.approve(tool.describe(call.input)))) {
      return result('The user denied this action. Ask them how to proceed or try a different approach.', true);
    }

    try {
      const out = await tool.execute(call.input, ctx);
      return result(out.content, out.isError);
    } catch (err) {
      if (err instanceof ToolInputError) return result(`Invalid input: ${err.message}`, true);
      const e = err as NodeJS.ErrnoException;
      if (e.name === 'AbortError' || ctx.signal?.aborted) return result('Interrupted by the user.', true);
      return result(`${e.code ? `${e.code}: ` : ''}${e.message ?? String(err)}`, true);
    }
  }
}
