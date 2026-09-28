import { headTail } from '../compaction/compact.js';
import { formatDuration, statusLabel } from './processes.js';
import { runProcess } from './process.js';
import { type Tool, ToolInputError, num, str } from './types.js';

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** How long a background start waits to catch immediate failures. */
const BACKGROUND_SETTLE_MS = 1_500;

export const bashTool: Tool = {
  mutates: true,
  spec: {
    name: 'bash',
    description:
      'Run a shell command in the project root (non-interactive; stdin is closed). Output is combined stdout+stderr. ' +
      'For long-running commands (dev servers, watchers, anything that does not exit), set background: true; ' +
      'you get a process id back immediately, then use process_output to read its output and process_kill to stop it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: `Foreground only. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
        background: { type: 'boolean', description: 'Run without waiting for exit (default false).' },
      },
      required: ['command'],
    },
  },
  describe: (i) => `$ ${String(i.command)}${i.background === true ? '  (background)' : ''}`,
  async execute(input, ctx) {
    const command = str(input, 'command');
    const background = input.background === true;
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, num(input, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS);
    const proc = ctx.processes.start({ command, cwd: ctx.cwd, background, timeoutMs, signal: ctx.signal });

    if (background) {
      await Promise.race([proc.done, new Promise((r) => setTimeout(r, BACKGROUND_SETTLE_MS))]);
      const early = proc.output.trimEnd();
      if (!proc.running) {
        return {
          content: `Background process #${proc.info.id} ended within ${BACKGROUND_SETTLE_MS}ms (${statusLabel(proc.info)}).\n${early || '(no output)'}`,
          isError: proc.info.exitCode !== 0,
        };
      }
      return {
        content:
          `Started background process #${proc.info.id} (pid ${proc.info.pid}). ` +
          `Check it with process_output {"id": ${proc.info.id}}; stop it with process_kill {"id": ${proc.info.id}}.` +
          (early ? `\nOutput so far:\n${headTail(early, 4_000)}` : ''),
      };
    }

    await proc.done;
    const out = proc.output.length > MAX_OUTPUT ? headTail(proc.output, MAX_OUTPUT) : proc.output;
    const status = proc.info.status === 'timed_out' ? `timed out after ${timeoutMs}ms` : statusLabel(proc.info);
    const failed = proc.info.status !== 'exited' || proc.info.exitCode !== 0;
    return { content: `${out.trimEnd() || '(no output)'}\n[${status}]`, isError: failed };
  },
};

function procId(input: Record<string, unknown>): number {
  const id = num(input, 'id');
  if (id === undefined) throw new ToolInputError('"id" is required');
  return id;
}

export const processOutputTool: Tool = {
  mutates: false,
  spec: {
    name: 'process_output',
    description: 'Read recent output and status of a process started with bash (background or finished).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Process id returned by bash.' },
        tail_lines: { type: 'number', description: 'Lines from the end to return (default 80).' },
      },
      required: ['id'],
    },
  },
  describe: (i) => `output of #${String(i.id)}`,
  async execute(input, ctx) {
    const proc = ctx.processes.get(procId(input));
    if (!proc) return { content: `No process #${String(input.id)}. Use process_list to see ids.`, isError: true };
    const lines = Math.min(500, Math.max(1, num(input, 'tail_lines') ?? 80));
    const age = formatDuration((proc.info.endedAt ?? Date.now()) - proc.info.startedAt);
    return { content: `#${proc.info.id} ${proc.info.command}\n[${statusLabel(proc.info)}, ${age}]\n${proc.tail(lines) || '(no output yet)'}` };
  },
};

export const processKillTool: Tool = {
  mutates: false, // only ever stops processes baton itself started
  spec: {
    name: 'process_kill',
    description: 'Stop a process started with bash (SIGTERM, then SIGKILL after 2s).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  describe: (i) => `stop #${String(i.id)}`,
  async execute(input, ctx) {
    const id = procId(input);
    const proc = ctx.processes.get(id);
    if (!proc) return { content: `No process #${id}.`, isError: true };
    if (!proc.running) return { content: `#${id} already stopped (${statusLabel(proc.info)}).` };
    ctx.processes.kill(id);
    return { content: `Stopped #${id} (${proc.info.command}).` };
  },
};

export const processListTool: Tool = {
  mutates: false,
  spec: {
    name: 'process_list',
    description: 'List processes started with bash in this session, with status.',
    inputSchema: { type: 'object', properties: {} },
  },
  describe: () => 'list processes',
  async execute(_input, ctx) {
    const procs = ctx.processes.list();
    if (!procs.length) return { content: 'No processes started this session.' };
    return {
      content: procs
        .map((p) => `#${p.info.id}  ${statusLabel(p.info).padEnd(10)} ${formatDuration((p.info.endedAt ?? Date.now()) - p.info.startedAt).padStart(7)}  ${p.info.command}`)
        .join('\n'),
    };
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
