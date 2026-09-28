import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Checkpoints } from '../src/tools/checkpoints.js';
import { acceptMention, expandMentions, fuzzyFiles, mentionAt } from '../src/ui/tui/mentions.js';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-cp-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'local.log\n');
  writeFileSync(join(dir, 'a.txt'), 'v1\n');
  writeFileSync(join(dir, 'local.log'), 'keep me\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'x');
  return dir;
}

describe('checkpoints (undo / rewind)', () => {
  it('restores files exactly, removes files created since, and leaves ignored files and the project repo alone', async () => {
    const dir = project();
    const cp = new Checkpoints(dir, mkdtempSync(join(tmpdir(), 'baton-cph-')));
    const before = await cp.snapshot('add a feature');
    writeFileSync(join(dir, 'a.txt'), 'v2\n');
    writeFileSync(join(dir, 'new.txt'), 'created\n');
    expect(await cp.changedSince(before!.id)).toEqual(['a.txt', 'new.txt']);

    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
    expect((await cp.restore(before!.id)).sort()).toEqual(['a.txt', 'new.txt']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(dir, 'new.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'local.log'), 'utf8')).toBe('keep me\n');
    expect(existsSync(join(dir, 'node_modules', 'dep.js'))).toBe(true);
    expect(existsSync(join(dir, '.git', 'refs', 'heads'))).toBe(true);
    // The project's own repo never saw a commit from baton.
    expect(execFileSync('git', ['rev-list', '--all', '--count'], { cwd: dir }).toString().trim()).toBe('0');
    expect(statusBefore).toContain('new.txt');
  });

  it('can undo a rewind via the automatic "before rewind" snapshot', async () => {
    const dir = project();
    const cp = new Checkpoints(dir, mkdtempSync(join(tmpdir(), 'baton-cph-')));
    const s1 = await cp.snapshot('first');
    writeFileSync(join(dir, 'a.txt'), 'v2\n');
    await cp.restore(s1!.id);
    const [latest] = await cp.list(1);
    expect(latest!.label).toBe('before rewind');
    await cp.restore(latest!.id);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('refuses to snapshot a home folder', () => {
    expect(new Checkpoints(homedir()).available).toBe(false);
  });
});

describe('@file mentions', () => {
  const files = ['src/server.js', 'src/routes/health.js', 'test/server.test.js', 'README.md', 'package.json'];

  it('finds the @query at the cursor and ranks by basename first', () => {
    expect(mentionAt('look at @serv', 13)).toEqual({ start: 8, query: 'serv' });
    expect(mentionAt('email me@x.com', 14)).toBeUndefined();
    expect(fuzzyFiles(files, 'serv')).toEqual(['src/server.js', 'test/server.test.js']);
    expect(fuzzyFiles(files, 'hlth')[0]).toBe('src/routes/health.js'); // subsequence match
    expect(fuzzyFiles(files, 'routes')).toContain('src/routes/');
  });

  it('inserts the chosen path in place of the query', () => {
    expect(acceptMention('fix @serv please', 9, 'src/server.js')).toEqual({ value: 'fix @src/server.js  please', cursor: 19 });
  });

  it('attaches mentioned files and folders, leaving other @words alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-at-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const x = 1;\nexport const y = 2;\n');
    const { prompt, attached } = expandMentions('explain @src/app.ts and ping @alice about @src', dir);
    expect(attached).toEqual([
      { path: 'src/app.ts', detail: '2 lines' },
      { path: 'src/', detail: '1 entries' },
    ]);
    expect(prompt).toContain('<file path="src/app.ts">\nexport const x = 1;');
    expect(prompt).toContain('<directory path="src/">\napp.ts');
    expect(prompt).not.toContain('alice"');
  });
});
