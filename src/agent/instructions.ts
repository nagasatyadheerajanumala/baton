import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Project and personal instruction files, shared by every model in the chain
 * so a provider switch never loses the repo's conventions. Reads the files
 * Codex (AGENTS.md) and Claude Code (CLAUDE.md) users already have, resolving
 * Claude-style `@path` imports.
 */

export interface InstructionFile {
  /** Absolute path. */
  path: string;
  /** How it's shown to the user and the model, e.g. "AGENTS.md" or "~/.claude/CLAUDE.md". */
  label: string;
  content: string;
}

const PER_FILE_CAP = 30_000;
const TOTAL_CAP = 80_000;
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'];

function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Nearest folder at or above `cwd` that contains .git, or `cwd` itself. */
export function projectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Expand `@path` imports (whole-line, or inline tokens that point at an
 * existing file), outside code fences. Imported files that were already
 * included elsewhere are replaced by a short reference instead of repeated.
 */
function expandImports(content: string, fromFile: string, seen: Set<string>, depth: number): string {
  if (depth > 4) return content;
  let inFence = false;
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/(^|\s)@((?:~\/|\.{0,2}\/)?[\w./-]+\.[\w]+)/g, (match, pre: string, ref: string) => {
        const target = ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(fromFile), ref);
        if (!existsSync(target) || !statSync(target).isFile()) return match;
        const key = realpath(target);
        if (seen.has(key)) return `${pre}(see ${tildify(target)} above)`;
        seen.add(key);
        const body = readFileSync(target, 'utf8').slice(0, PER_FILE_CAP);
        return `${pre}\n<!-- imported from ${tildify(target)} -->\n${expandImports(body, target, seen, depth + 1)}\n`;
      });
    })
    .join('\n');
}

export function loadInstructions(cwd: string, env: NodeJS.ProcessEnv = process.env): InstructionFile[] {
  const home = homedir();
  const candidates: { path: string; label: string }[] = [
    { path: join(env.BATON_HOME ?? join(home, '.baton'), 'AGENTS.md'), label: '~/.baton/AGENTS.md (your baton instructions)' },
    { path: join(env.CODEX_HOME ?? join(home, '.codex'), 'AGENTS.md'), label: '~/.codex/AGENTS.md (your Codex instructions)' },
    { path: join(home, '.claude', 'CLAUDE.md'), label: '~/.claude/CLAUDE.md (your Claude Code instructions)' },
  ];
  // Project files from the repo root down to the current folder, so nearer ones come last and win.
  const root = projectRoot(cwd);
  const chain: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dir === root || dirname(dir) === dir) break;
  }
  for (const dir of chain) for (const f of PROJECT_FILES) candidates.push({ path: join(dir, f), label: relative(cwd, join(dir, f)) || f });

  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  let total = 0;
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const key = realpath(c.path);
    if (seen.has(key)) continue;
    seen.add(key);
    let content: string;
    try {
      content = readFileSync(c.path, 'utf8').slice(0, PER_FILE_CAP);
    } catch {
      continue;
    }
    content = expandImports(content, c.path, seen, 0).trim();
    // A file that only imported something already included adds nothing.
    if (!content || /^(\(see [^)]+ above\)\s*)+$/.test(content)) continue;
    if (total + content.length > TOTAL_CAP) content = `${content.slice(0, Math.max(0, TOTAL_CAP - total))}\n[... truncated]`;
    total += content.length;
    files.push({ path: c.path, label: c.label, content });
    if (total >= TOTAL_CAP) break;
  }
  return files;
}

/** System-prompt section for the loaded files ('' when there are none). */
export function instructionsPrompt(files: InstructionFile[]): string {
  if (!files.length) return '';
  const parts = files.map((f) => `## ${f.label}\n\n${f.content}`);
  return `\n\n# Instructions from the user's files\nThese come from instruction files in the user's home folder and this project. Follow them; files listed later are more specific and take precedence.\n\n${parts.join('\n\n')}`;
}

export const INIT_PROMPT = `Create (or improve, if it exists) an AGENTS.md file at the root of this project so that any AI coding agent can work here effectively.

First explore the repository: build/test/lint commands, the overall architecture, key directories, conventions visible in the code, and anything surprising. Then write AGENTS.md with:
- the exact commands to build, test (including a single test), lint and run
- a short architecture overview of the parts that need several files to understand
- conventions and rules the code clearly follows
Keep it concise and specific to this repo: no generic advice, no invented details. If a CLAUDE.md exists, keep it working (for example by making it import AGENTS.md with a line "@AGENTS.md").`;
