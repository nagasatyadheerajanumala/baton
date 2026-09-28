/**
 * Decide whether a shell command only reads, so it can run without an
 * approval prompt (like `git status`, `ls`, `rg`). Deliberately conservative:
 * anything not understood — substitutions, redirects to files, unknown
 * programs, writing flags — returns false and the user is asked.
 */

/** Programs that never modify anything with any flags. */
const SAFE = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'type', 'file', 'stat', 'du', 'df',
  'rg', 'grep', 'egrep', 'fgrep', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami',
  'uname', 'true', 'false', 'test', '[', 'cd', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'cmp', 'comm',
  'jq', 'column', 'less', 'more', 'md5', 'shasum', 'sha256sum', 'md5sum', 'id', 'hostname',
]);

/** Shell keywords that only structure the script. */
const KEYWORDS = new Set(['do', 'done', 'then', 'else', 'elif', 'fi', 'if', 'while', 'until', '{', '}', '!']);

const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'grep', 'cat-file', 'rev-list', 'merge-base', 'name-rev', 'whatchanged', 'count-objects', 'check-ignore',
]);
const GIT_LIST_ONLY: Record<string, Set<string>> = {
  branch: new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--verbose', '--no-color', '--color']),
  tag: new Set(['-l', '--list', '-n']),
  remote: new Set(['-v', '--verbose', 'show', 'get-url']),
  stash: new Set(['list', 'show']),
  worktree: new Set(['list', '--porcelain']),
  config: new Set(['--get', '--list', '-l', '--get-all', '--show-origin']),
};

/** Split into words, honouring quotes. Returns null on anything we won't reason about. */
function words(segment: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '`' || (ch === '$' && segment[i + 1] === '('))) return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === '`' || (ch === '$' && segment[i + 1] === '(')) return null; // command substitution
    else if (ch === ' ' || ch === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

/** Split a script into simple commands on ; && || | and newlines, outside quotes. */
export function splitCommands(script: string): string[] | null {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (ch === '&' && script[i + 1] !== '&' && script[i - 1] !== '&' && script[i - 1] !== '>') return null; // background job
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (quote) return null;
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Strip allowed redirections (to /dev/null, fd dups, input); null if it writes a file. */
function stripRedirects(ws: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const m = /^(\d*)(>>?|<)(.*)$/.exec(w);
    if (!m) {
      if (w.includes('>')) return null;
      out.push(w);
      continue;
    }
    const [, , op, rest] = m;
    const target = rest || ws[++i] || '';
    if (op === '<') continue;
    if (target === '/dev/null' || /^&\d$/.test(target)) continue;
    return null; // writes to a file
  }
  return out;
}

function isReadOnlySimple(segment: string): boolean {
  let ws = words(segment);
  if (!ws) return false;
  ws = stripRedirects(ws);
  if (!ws) return false;
  while (ws.length && KEYWORDS.has(ws[0]!)) ws = ws.slice(1);
  if (ws.length === 0) return true;
  // `for x in a b c` header; the body is checked as its own segments.
  if (ws[0] === 'for') return ws.length >= 3 && ws[2] === 'in';
  // Leading VAR=value assignments.
  while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]!)) ws = ws.slice(1);
  if (ws.length === 0) return true;

  const [cmd, ...args] = ws as [string, ...string[]];
  if (SAFE.has(cmd)) return true;
  if (cmd === 'find') return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a));
  if (cmd === 'sed') return !args.some((a) => a.startsWith('-i') || a === '--in-place') && args.includes('-n');
  if (cmd === 'git') return isReadOnlyGit(args);
  return false;
}

function isReadOnlyGit(args: string[]): boolean {
  let i = 0;
  // Global options: -C <dir>, --no-pager, -c k=v is not allowed (could set an alias/hook).
  while (i < args.length && args[i]!.startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager' || args[i] === '--no-optional-locks') i++;
    else return false;
  }
  const sub = args[i];
  if (!sub) return false;
  const rest = args.slice(i + 1);
  if (GIT_READ.has(sub)) return !rest.some((a) => a === '--output' || a.startsWith('--output=') || a === '--ext-diff');
  const allowed = GIT_LIST_ONLY[sub];
  if (!allowed) return false;
  if (sub === 'worktree' || sub === 'stash') return rest[0] !== undefined && allowed.has(rest[0]);
  return rest.every((a) => allowed.has(a) || (!a.startsWith('-') && sub === 'remote' && rest[0] === 'show'));
}

/** Unwrap `bash -lc "..."` / `/bin/zsh -c '...'` so the inner script is what gets judged and shown. */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]!.replace(/\\"/g, '"') : command;
}

export function isReadOnlyCommand(command: string): boolean {
  const parts = splitCommands(unwrapShell(command));
  return parts !== null && parts.length > 0 && parts.every(isReadOnlySimple);
}
