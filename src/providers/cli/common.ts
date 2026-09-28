import { spawn } from 'node:child_process';
import type { Message } from '../../ir/types.js';

/**
 * Turn an agent CLI's error text into an error the router can classify:
 * subscription limit -> 429 quota (with reset time when stated),
 * not signed in -> 401 auth, overload -> 529.
 */
export function cliError(message: string, provider: string): Error {
  const m = message.trim() || `${provider} exited without a result`;
  let status: number | undefined;
  let retryAfterSec: number | undefined;
  if (/not logged in|failed to authenticate|please run \/login|run `?(claude|codex) login|login required|unauthori[sz]ed|invalid api key|oauth (session|token)/i.test(m)) {
    status = 401;
  } else if (/usage limit|hit your (usage )?limit|limit reached|out of (credits|usage)|quota|upgrade to (pro|plus|max)/i.test(m)) {
    status = 429;
    const epoch = /\|(\d{10})\b/.exec(m); // "Claude AI usage limit reached|1759262400"
    const rel = /in (\d+) (second|minute|hour|day)s?/i.exec(m); // "try again in 2 hours"
    if (epoch) retryAfterSec = Math.max(0, Number(epoch[1]) - Date.now() / 1000);
    else if (rel) retryAfterSec = Number(rel[1]) * { second: 1, minute: 60, hour: 3_600, day: 86_400 }[rel[2]!.toLowerCase() as 'second']!;
  } else if (/model\b[^.]{0,80}(not found|not available|isn't available|is not supported|does not exist|invalid)|unknown model|no access to model/i.test(m)) {
    status = 404; // lets the router mark just this model unavailable and fail over
  } else if (/overloaded|529|503|temporarily unavailable/i.test(m)) {
    status = 529;
  } else if (/rate limit/i.test(m)) {
    status = 429;
  }
  const headers = new Headers();
  if (retryAfterSec !== undefined) headers.set('retry-after', String(Math.ceil(retryAfterSec)));
  // "quota" wording makes classifyError treat 429s from plan limits as quota, not a short rate limit.
  const text = status === 429 && !/rate limit/i.test(m) ? `${m} (subscription usage limit / quota)` : m;
  return Object.assign(new Error(`${provider}: ${text}`), { status, headers });
}

export interface JsonlRun {
  code: number | null;
  stderr: string;
}

/** Spawn a CLI, write `stdin`, and hand each stdout JSON line to `onEvent`. */
export function runJsonl(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdin: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onEvent: (e: Record<string, unknown>) => void },
): Promise<JsonlRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let handlerError: unknown;
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          opts.onEvent(JSON.parse(line) as Record<string, unknown>);
        } catch (e) {
          handlerError ??= e;
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64_000) stderr += d.toString('utf8');
    });
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e.code === 'ENOENT' ? Object.assign(new Error(`${cmd} is not installed or not on PATH`), { status: 401 }) : e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (handlerError) return reject(handlerError);
      resolve({ code, stderr });
    });
    child.stdin.on('error', () => {}); // CLI may exit before reading all input
    child.stdin.end(opts.stdin);
  });
}

/** Per-model CLI session plus which baton messages it has already seen. */
export class CliSessions {
  private readonly sessions = new Map<string, { id: string; seen: Set<string> }>();

  get(model: string) {
    return this.sessions.get(model);
  }

  /** Messages the CLI hasn't seen, excluding its own replies (it has those in its session). */
  unseen(model: string, messages: Message[], self: string): Message[] {
    const s = this.sessions.get(model);
    return messages.filter((m) => !s?.seen.has(m.id) && !(m.role === 'assistant' && m.meta.provider === self));
  }

  remember(model: string, id: string, ids: Iterable<string>): void {
    const s = this.sessions.get(model);
    const seen = s && s.id === id ? s.seen : new Set<string>();
    for (const i of ids) seen.add(i);
    this.sessions.set(model, { id, seen });
  }
}
