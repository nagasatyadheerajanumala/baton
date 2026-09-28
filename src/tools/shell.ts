import { headTail } from '../compaction/compact.js';
import { runProcess } from './process.js';
import { type Tool, num, str } from './types.js';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export const bashTool: Tool = {
  mutates: true,
  spec: {
    name: 'bash',
    description:
      'Run a shell command in the project root (non-interactive; stdin is closed). ' +
      'Use for builds, tests, linters, package managers and git. Output is combined stdout+stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: `Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
      },
      required: ['command'],
    },
  },
  describe: (i) => `$ ${String(i.command)}`,
  async execute(input, ctx) {
    const command = str(input, 'command');
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, num(input, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS);
    const r = await runProcess('bash', ['-c', command], { cwd: ctx.cwd, timeoutMs, signal: ctx.signal });
    const out = r.output.length > MAX_OUTPUT ? headTail(r.output, MAX_OUTPUT) : r.output;
    const status = r.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${r.code}`;
    return { content: `${out.trimEnd() || '(no output)'}\n[${status}]`, isError: r.timedOut || r.code !== 0 };
  },
};

/** Read-only git snapshot. Also used for the provider handoff note. */
export const gitStatusTool: Tool = {
  mutates: false,
  spec: {
    name: 'git_status',
    description: 'Show branch, working-tree status and a diffstat of uncommitted changes.',
    inputSchema: { type: 'object', properties: {} },
  },
  describe: () => 'git status',
  async execute(_input, ctx) {
    return { content: await gitSnapshot(ctx.cwd, ctx.signal) };
  },
};

export async function gitSnapshot(cwd: string, signal?: AbortSignal): Promise<string> {
  const opts = { cwd, timeoutMs: 15_000, signal };
  const status = await runProcess('git', ['status', '--short', '--branch'], opts).catch(() => undefined);
  if (!status || status.code !== 0) return 'Not a git repository.';
  const stat = await runProcess('git', ['diff', 'HEAD', '--stat'], opts).catch(() => undefined);
  const diffstat = stat?.code === 0 && stat.output.trim() ? `\n\n${stat.output.trimEnd()}` : '';
  return status.output.trimEnd() + diffstat;
}
