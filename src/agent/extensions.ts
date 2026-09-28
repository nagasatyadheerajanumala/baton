import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { projectRoot } from './instructions.js';

/**
 * Skills and custom slash commands from the places Claude Code and Codex
 * users already keep them, so they work in baton unchanged:
 *   skills:   .claude/skills/<name>/SKILL.md, .agents/skills/..., .codex/skills/..., .baton/skills/...
 *   commands: .claude/commands/**.md, ~/.codex/prompts/*.md, .baton/commands/**.md
 * Project copies (repo root down to the current folder) take precedence over
 * personal ones with the same name.
 */

export type Origin = 'project' | 'claude' | 'codex' | 'agents' | 'baton';

export interface Skill {
  name: string;
  description: string;
  /** Path to SKILL.md. */
  path: string;
  /** Folder that relative references in the skill resolve against. */
  dir: string;
  origin: Origin;
}

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
  origin: Origin;
}

// ---- Frontmatter ------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter reader: top-level `key: value` pairs, quoted
 * strings, folded/literal blocks (`>` / `|`) and `- item` lists. Enough for
 * SKILL.md and command files; anything fancier is ignored rather than fatal.
 */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    const block: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!);
    if (value === '' && block.some((b) => /^\s*-\s/.test(b))) {
      data[key] = block.filter((b) => /^\s*-\s/.test(b)).map((b) => b.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, ''));
      continue;
    }
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || (value === '' && block.length)) {
      const joined = block.map((b) => b.trim());
      value = value.startsWith('|') ? joined.join('\n') : joined.join(' ');
    } else if (block.length) {
      value = [value, ...block.map((b) => b.trim())].join(' '); // plain multi-line scalar
    }
    data[key] = value.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  }
  return { data, body: text.slice(m[0].length) };
}

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(' ') : v ?? '');

// ---- Discovery ---------------------------------------------------------------------------

function projectDirs(cwd: string): string[] {
  const root = projectRoot(cwd);
  const out: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    out.push(dir); // nearest first
    if (dir === root || dirname(dir) === dir) break;
  }
  return out;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') && statSync(join(dir, n)).isDirectory());
  } catch {
    return [];
  }
}

function listMarkdown(dir: string, prefix = ''): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of entries) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory() && !n.startsWith('.')) out.push(...listMarkdown(p, `${prefix}${n}/`));
    else if (n.endsWith('.md')) out.push({ name: `${prefix}${n.slice(0, -3)}`, path: p });
  }
  return out;
}

const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string, fn: () => T, ttlMs = 20_000): T {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Skills available in `cwd` (cached briefly; the list is re-read every 20s so edits show up). */
export function loadSkills(cwd: string, env: NodeJS.ProcessEnv = process.env): Skill[] {
  return cached(`skills:${cwd}:${env.BATON_HOME ?? ''}:${env.CODEX_HOME ?? ''}`, () => scanSkills(cwd, env));
}

/** Custom slash commands available in `cwd` (cached briefly). */
export function loadCommands(cwd: string, env: NodeJS.ProcessEnv = process.env): CustomCommand[] {
  return cached(`commands:${cwd}:${env.BATON_HOME ?? ''}:${env.CODEX_HOME ?? ''}`, () => scanCommands(cwd, env));
}

function scanSkills(cwd: string, env: NodeJS.ProcessEnv): Skill[] {
  const home = homedir();
  const roots: { dir: string; origin: Origin }[] = [];
  for (const d of projectDirs(cwd)) {
    for (const sub of ['.baton/skills', '.claude/skills', '.agents/skills', '.codex/skills']) roots.push({ dir: join(d, sub), origin: 'project' });
  }
  roots.push(
    { dir: join(env.BATON_HOME ?? join(home, '.baton'), 'skills'), origin: 'baton' },
    { dir: join(home, '.claude', 'skills'), origin: 'claude' },
    { dir: join(home, '.agents', 'skills'), origin: 'agents' },
    { dir: join(env.CODEX_HOME ?? join(home, '.codex'), 'skills'), origin: 'codex' },
  );
  const seen = new Set<string>();
  const skills: Skill[] = [];
  for (const { dir, origin } of roots) {
    for (const folder of listDirs(dir)) {
      const path = join(dir, folder, 'SKILL.md');
      if (!existsSync(path)) continue;
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(text);
      const name = (str(data.name) || folder).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description: str(data.description).replace(/\s+/g, ' ').trim(), path, dir: join(dir, folder), origin });
    }
  }
  return skills;
}

function scanCommands(cwd: string, env: NodeJS.ProcessEnv): CustomCommand[] {
  const home = homedir();
  const roots: { dir: string; origin: Origin; prefix?: string }[] = [];
  for (const d of projectDirs(cwd)) {
    roots.push({ dir: join(d, '.baton', 'commands'), origin: 'project' }, { dir: join(d, '.claude', 'commands'), origin: 'project' });
  }
  roots.push(
    { dir: join(env.BATON_HOME ?? join(home, '.baton'), 'commands'), origin: 'baton' },
    { dir: join(home, '.claude', 'commands'), origin: 'claude' },
    { dir: join(env.CODEX_HOME ?? join(home, '.codex'), 'prompts'), origin: 'codex' },
  );
  const seen = new Set<string>();
  const out: CustomCommand[] = [];
  for (const { dir, origin } of roots) {
    for (const f of listMarkdown(dir)) {
      // Claude namespaces subfolders only in the description; the command is the file name.
      const name = basename(f.name);
      if (seen.has(name)) continue;
      seen.add(name);
      let data: Record<string, string | string[]> = {};
      let body = '';
      try {
        ({ data, body } = parseFrontmatter(readFileSync(f.path, 'utf8')));
      } catch {
        continue;
      }
      const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      const ns = f.name.includes('/') ? ` (${dirname(f.name)})` : '';
      out.push({
        name,
        description: (str(data.description) || firstLine).replace(/\s+/g, ' ').slice(0, 160) + ns,
        argumentHint: str(data['argument-hint']) || undefined,
        path: f.path,
        origin,
      });
    }
  }
  return out;
}

// ---- Expansion ----------------------------------------------------------------------------

/** Split arguments like a shell would for $1..$9 (quotes respected). */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of args.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Turn a command file into the prompt to send: $ARGUMENTS, $1..$9, and
 * Codex-style KEY=value named arguments ($KEY). `!`cmd`` lines are run by the
 * caller (runShell) and replaced with their output, as in Claude Code.
 */
export async function expandCommand(cmd: CustomCommand, args: string, runShell: (command: string) => Promise<string>): Promise<string> {
  const { body } = parseFrontmatter(readFileSync(cmd.path, 'utf8'));
  const positional = splitArgs(args);
  const named: Record<string, string> = {};
  for (const a of positional) {
    const kv = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(a);
    if (kv) named[kv[1]!] = kv[2]!;
  }
  let text = body
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\$([1-9])/g, (_m, n: string) => positional[Number(n) - 1] ?? '')
    .replace(/\$([A-Z][A-Z0-9_]*)\b/g, (m, k: string) => named[k] ?? m);
  const shells = [...text.matchAll(/!`([^`]+)`/g)];
  for (const s of shells) text = text.replace(s[0], (await runShell(s[1]!)).trim());
  if (!/\$ARGUMENTS/.test(body) && args.trim() && !/\$[1-9A-Z]/.test(body)) text += `\n\nArguments: ${args}`;
  return text.trim();
}

/** The prompt for running a skill directly as /name. */
export function skillPrompt(skill: Skill, args: string): string {
  const { body } = parseFrontmatter(readFileSync(skill.path, 'utf8'));
  return `Use the "${skill.name}" skill for this request. Its instructions follow (relative paths are under ${skill.dir}).\n\n<skill name="${skill.name}">\n${body.trim()}\n</skill>${args.trim() ? `\n\nRequest: ${args.trim()}` : ''}`;
}

/** System-prompt section: skills the model can load on demand with the `skill` tool. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description.slice(0, 220) || '(no description)'}`);
  return `\n\n# Skills\nThe user has these skills installed. When a request matches one, call the \`skill\` tool with its name to load its full instructions, then follow them.\n${lines.join('\n')}`;
}

export function relativeToHome(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~/${relative(home, p)}` : p;
}
