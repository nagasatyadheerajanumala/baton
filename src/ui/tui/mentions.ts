import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { runProcess } from '../../tools/process.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'target', '.turbo']);
const MAX_FILES = 20_000;
const MAX_ATTACH_BYTES = 200_000;

/** Files under `cwd` (git-tracked plus untracked-but-not-ignored when in a repo). */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const git = await runProcess('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, timeoutMs: 10_000, maxBytes: 5_000_000 }).catch(() => undefined);
  if (git && git.code === 0) return git.output.split('\n').filter(Boolean).slice(0, MAX_FILES);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        if (!IGNORED.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name));
      } else out.push(relative(cwd, join(dir, e.name)));
    }
  };
  await walk(cwd);
  return out;
}

/** The `@query` being typed at the cursor, if any. */
export function mentionAt(value: string, cursor: number): { start: number; query: string } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor));
  if (!m) return undefined;
  return { start: cursor - m[2]!.length - 1, query: m[2]! };
}

/** Folders implied by the file list, so directories can be mentioned too. */
function dirsOf(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...dirs];
}

/** Rank paths for a query: basename prefix > basename contains > path contains > in-order subsequence. */
export function fuzzyFiles(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const pool = [...files, ...dirsOf(files)];
  if (!q) return pool.filter((p) => !p.endsWith('/') || p.split('/').length === 2).sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length).slice(0, limit);
  const scored: { p: string; s: number }[] = [];
  for (const p of pool) {
    const lp = p.toLowerCase();
    const base = lp.replace(/\/$/, '').split('/').pop()!;
    let s: number;
    if (base.startsWith(q)) s = 0;
    else if (base.includes(q)) s = 1;
    else if (lp.includes(q)) s = 2;
    else {
      let i = 0;
      for (const ch of lp) if (ch === q[i]) i++;
      if (i < q.length) continue;
      s = 3;
    }
    scored.push({ p, s: s * 1000 + p.length });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.p);
}

/** Replace the `@query` at the cursor with the chosen path. */
export function acceptMention(value: string, cursor: number, path: string): { value: string; cursor: number } {
  const at = mentionAt(value, cursor);
  if (!at) return { value, cursor };
  const insert = `@${path}${path.endsWith('/') ? '' : ' '}`;
  const next = value.slice(0, at.start) + insert + value.slice(cursor);
  return { value: next, cursor: at.start + insert.length };
}

export interface Attachment {
  path: string;
  /** "42 lines", "12 entries", "too large", ... */
  detail: string;
}

/**
 * Attach the contents of every @mentioned file (or a listing for folders) to
 * the prompt. Unknown @words are left alone, so "@someone" in prose is fine.
 */
export function expandMentions(text: string, cwd: string): { prompt: string; attached: Attachment[] } {
  const attached: Attachment[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const ref = m[1]!.replace(/[.,;:!?)]+$/, '');
    const abs = resolve(cwd, ref);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    const rel = relative(cwd, abs) || '.';
    const st = statSync(abs);
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true }).filter((e) => !IGNORED.has(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      blocks.push(`<directory path="${rel}/">\n${entries.slice(0, 300).join('\n')}${entries.length > 300 ? `\n… ${entries.length - 300} more` : ''}\n</directory>`);
      attached.push({ path: `${rel}/`, detail: `${entries.length} entries` });
    } else if (st.size > MAX_ATTACH_BYTES) {
      blocks.push(`<file path="${rel}">(${Math.round(st.size / 1024)} KB: too large to attach; read the parts you need)</file>`);
      attached.push({ path: rel, detail: 'too large; the model will read what it needs' });
    } else {
      const content = readFileSync(abs, 'utf8');
      if (content.includes('\u0000')) continue; // binary
      blocks.push(`<file path="${rel}">\n${content}\n</file>`);
      const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      attached.push({ path: rel, detail: `${lines} line${lines === 1 ? '' : 's'}` });
    }
  }
  if (!blocks.length) return { prompt: text, attached };
  return { prompt: `${text}\n\nFiles the user attached (current contents):\n\n${blocks.join('\n\n')}`, attached };
}
