import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Checkpoint {
  id: string;
  label: string;
  /** Unix ms. */
  ts: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Heavy folders not worth snapshotting even when a project forgets to .gitignore them. */
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.turbo/', 'target/', '.gradle/', '.DS_Store'];

/**
 * File snapshots taken before each request, so any request's changes can be
 * undone. Stored in a private git repository per project under
 * ~/.baton/checkpoints/ whose work tree is the project: the project's own
 * .git, branches and history are never touched, and .gitignore is honoured.
 */
export class Checkpoints {
  readonly gitDir: string;
  private initialized = false;
  /** Set if snapshots proved too slow or failed; checkpointing stops for the session. */
  disabledReason?: string;

  constructor(
    readonly cwd: string,
    home: string = process.env.BATON_HOME ?? join(homedir(), '.baton'),
  ) {
    let real = resolve(cwd);
    try {
      real = realpathSync(cwd);
    } catch {
      /* keep resolved path */
    }
    this.gitDir = join(home, 'checkpoints', `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.git`);
  }

  /** Snapshotting a home folder or the filesystem root would copy far too much. */
  get available(): boolean {
    const r = resolve(this.cwd);
    return !this.disabledReason && r !== resolve(homedir()) && r !== '/';
  }

  private git(args: string[], timeoutMs = 30_000): Promise<GitResult> {
    const env = {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.cwd,
      GIT_AUTHOR_NAME: 'baton',
      GIT_AUTHOR_EMAIL: 'baton@localhost',
      GIT_COMMITTER_NAME: 'baton',
      GIT_COMMITTER_EMAIL: 'baton@localhost',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const base = ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false'];
    return new Promise((res) =>
      execFile('git', [...base, ...args], { cwd: this.cwd, env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
        res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
      ),
    );
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (!existsSync(this.gitDir)) {
      mkdirSync(this.gitDir, { recursive: true });
      const r = await this.git(['init', '-q']);
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'git init failed');
      mkdirSync(join(this.gitDir, 'info'), { recursive: true });
      writeFileSync(join(this.gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
    }
    this.initialized = true;
  }

  /** Record the current state of every file. Returns undefined if checkpoints aren't available. */
  async snapshot(label: string): Promise<Checkpoint | undefined> {
    if (!this.available) return undefined;
    try {
      await this.init();
      const add = await this.git(['add', '-A', '--', '.']);
      if (add.code !== 0) throw new Error(add.stderr.trim().split('\n')[0] || 'git add failed');
      const commit = await this.git(['commit', '-q', '--allow-empty', '--no-verify', '-m', label.replace(/\s+/g, ' ').slice(0, 200) || 'snapshot']);
      if (commit.code !== 0) throw new Error(commit.stderr.trim().split('\n')[0] || 'git commit failed');
      const head = await this.git(['rev-parse', 'HEAD']);
      return { id: head.stdout.trim(), label, ts: Date.now() };
    } catch (err) {
      this.disabledReason = (err as Error).message.includes('ETIMEDOUT') || (err as Error).message.includes('timed out') ? 'snapshots took too long for this folder' : (err as Error).message;
      return undefined;
    }
  }

  /** Newest first. */
  async list(limit = 30): Promise<Checkpoint[]> {
    if (!existsSync(this.gitDir)) return [];
    const r = await this.git(['log', `-n${limit}`, '--format=%H%x09%ct%x09%s']);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id = '', ct = '0', ...rest] = line.split('\t');
        return { id, ts: Number(ct) * 1000, label: rest.join('\t') };
      });
  }

  /** Files that differ between a checkpoint and the project right now. */
  async changedSince(id: string): Promise<string[]> {
    await this.init();
    await this.git(['add', '-A', '--', '.']);
    const r = await this.git(['diff', '--cached', '--name-only', id]);
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  /**
   * Put every file back exactly as it was at `id`, including removing files
   * created since. Takes a "before rewind" snapshot first, so the rewind can
   * itself be undone. Returns the files that changed.
   */
  async restore(id: string): Promise<string[]> {
    const before = await this.snapshot('before rewind');
    if (!before) throw new Error(this.disabledReason ?? 'checkpoints are not available here');
    const diff = await this.git(['diff', '--name-only', id, before.id]);
    const changed = diff.stdout.split('\n').filter(Boolean);
    const r = await this.git(['read-tree', '-u', '--reset', id]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || 'restore failed');
    return changed;
  }
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}
