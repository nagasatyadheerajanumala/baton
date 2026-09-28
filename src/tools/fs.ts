import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { headTail } from '../compaction/compact.js';
import { runProcess } from './process.js';
import { type Tool, ToolInputError, num, str } from './types.js';

const MAX_LINE = 2_000;
const DEFAULT_READ_LINES = 2_000;
const MAX_OUTPUT = 30_000;

export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Writes are confined to the project root; reads are not. */
function assertInsideRoot(cwd: string, abs: string): void {
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolInputError(`Refusing to write outside the project root (${cwd}): ${abs}`);
  }
}

export const readFileTool: Tool = {
  mutates: false,
  spec: {
    name: 'read_file',
    description:
      'Read a text file. Returns lines prefixed with line numbers. Use offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project root or absolute.' },
        offset: { type: 'number', description: '1-based line to start from (default 1).' },
        limit: { type: 'number', description: `Max lines to return (default ${DEFAULT_READ_LINES}).` },
      },
      required: ['path'],
    },
  },
  describe: (i) => `read ${String(i.path)}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, str(input, 'path'));
    const offset = Math.max(1, num(input, 'offset') ?? 1);
    const limit = Math.max(1, num(input, 'limit') ?? DEFAULT_READ_LINES);
    const text = await readFile(abs, 'utf8');
    if (text.includes('\u0000')) return { content: `${abs} looks like a binary file; not reading it.`, isError: true };
    const lines = text.split('\n');
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length).length;
    const body = slice
      .map((l, i) => `${String(offset + i).padStart(width)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l}`)
      .join('\n');
    const more = offset - 1 + slice.length < lines.length
      ? `\n\n[${lines.length - (offset - 1 + slice.length)} more lines; continue with offset=${offset + slice.length}]`
      : '';
    return { content: (body || '(empty file)') + more };
  },
};

export const writeFileTool: Tool = {
  mutates: true,
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Prefer edit_file for changes to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
    },
  },
  describe: (i) => `write ${String(i.path)}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, str(input, 'path'));
    assertInsideRoot(ctx.cwd, abs);
    const content = str(input, 'content');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    return { content: `Wrote ${lines} line${lines === 1 ? '' : 's'} to ${relative(ctx.cwd, abs)}` };
  },
};

export const editFileTool: Tool = {
  mutates: true,
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique ' +
      'unless replace_all is true. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  describe: (i) => `edit ${String(i.path)}`,
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, str(input, 'path'));
    assertInsideRoot(ctx.cwd, abs);
    const oldStr = str(input, 'old_string');
    const newStr = str(input, 'new_string');
    if (oldStr === newStr) throw new ToolInputError('old_string and new_string are identical');
    if (!oldStr) throw new ToolInputError('old_string is empty; use write_file to create a file');
    const text = await readFile(abs, 'utf8');
    const count = text.split(oldStr).length - 1;
    if (count === 0) return { content: `old_string not found in ${relative(ctx.cwd, abs)}. Re-read the file.`, isError: true };
    if (count > 1 && input.replace_all !== true) {
      return {
        content: `old_string occurs ${count} times in ${relative(ctx.cwd, abs)}. Add surrounding context or set replace_all.`,
        isError: true,
      };
    }
    const next = input.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
    await writeFile(abs, next, 'utf8');
    return { content: `Edited ${relative(ctx.cwd, abs)} (${count} replacement${count > 1 ? 's' : ''})` };
  },
};

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'target']);

export const listFilesTool: Tool = {
  mutates: false,
  spec: {
    name: 'list_files',
    description: 'List files under a directory (git-tracked + untracked-but-not-ignored when in a git repo).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory (default: project root).' } },
    },
  },
  describe: (i) => `list ${String(i.path ?? '.')}`,
  async execute(input, ctx) {
    const dir = resolvePath(ctx.cwd, str(input, 'path', false) || '.');
    const git = await runProcess('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: dir,
      timeoutMs: 15_000,
      signal: ctx.signal,
    }).catch(() => undefined);
    let files: string[];
    if (git && git.code === 0) {
      files = git.output.split('\n').filter(Boolean);
    } else {
      files = [];
      await walk(dir, dir, files, 2_000);
    }
    const shown = files.slice(0, 500);
    const more = files.length > shown.length ? `\n[${files.length - shown.length} more files not shown]` : '';
    return { content: (shown.join('\n') || '(no files)') + more };
  },
};

async function walk(root: string, dir: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= max) return;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walk(root, join(dir, entry.name), out, max);
    } else {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

export const searchTool: Tool = {
  mutates: false,
  spec: {
    name: 'search',
    description: 'Search file contents with a regular expression (ripgrep if installed, else grep). Returns file:line:match.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'Directory or file to search (default: project root).' },
        glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.ts".' },
      },
      required: ['pattern'],
    },
  },
  describe: (i) => `search /${String(i.pattern)}/`,
  async execute(input, ctx) {
    const pattern = str(input, 'pattern');
    const target = resolvePath(ctx.cwd, str(input, 'path', false) || '.');
    const glob = str(input, 'glob', false);
    const hasRg = await runProcess('rg', ['--version'], { cwd: ctx.cwd, timeoutMs: 5_000 }).then((r) => r.code === 0, () => false);
    const [cmd, args] = hasRg
      ? ['rg', ['-n', '--no-heading', '--color=never', ...(glob ? ['-g', glob] : []), '-e', pattern, target]]
      : ['grep', ['-rnE', ...(glob ? [`--include=${glob}`] : []), ...[...IGNORED_DIRS].map((d) => `--exclude-dir=${d}`), '-e', pattern, target]];
    const r = await runProcess(cmd, args as string[], { cwd: ctx.cwd, timeoutMs: 30_000, signal: ctx.signal });
    if (r.code === 1) return { content: 'No matches.' };
    if (r.code !== 0) return { content: r.output || `search failed (exit ${r.code})`, isError: true };
    const rel = r.output.split(`${ctx.cwd}/`).join('');
    return { content: rel.length > MAX_OUTPUT ? headTail(rel, MAX_OUTPUT) : rel };
  },
};

