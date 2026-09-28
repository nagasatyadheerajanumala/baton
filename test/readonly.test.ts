import { describe, expect, it } from 'vitest';
import { needsNoApproval } from '../src/tools/registry.js';
import { isReadOnlyCommand, unwrapShell } from '../src/tools/readonly.js';

describe('read-only command detection', () => {
  it.each([
    'git status --short --branch',
    'git -C sre-infra log -12 --format="%h %ad %s" --date=short',
    'git diff --stat',
    'git worktree list',
    'git branch -a',
    'ls -la src',
    'rg --files -g AGENTS.md -g package.json',
    'cat package.json | head -40',
    'for repo in vo-ts-monorepo sre-infra; do echo "$repo"; git -C "$repo" status --short --branch; git -C "$repo" log -12 --format=\'%h %ad %s\' --date=short; git -C "$repo" diff --stat; git -C "$repo" worktree list; done',
    'for p in AGENTS.md a/AGENTS.md; do if [ -f "$p" ]; then head -180 "$p"; fi; done',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'sed -n 1,40p src/index.ts',
    'wc -l src/*.ts 2>/dev/null',
    '/bin/zsh -lc "pwd; rg --files -g AGENTS.md"',
  ])('allows without asking: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true);
  });

  it.each([
    'rm -rf build',
    'git push',
    'git checkout -- .',
    'git reset --hard HEAD~1',
    'git branch -D feature',
    'git -c core.pager=evil log',
    'npm install',
    'npm test',
    'echo hi > file.txt',
    'cat a >> b',
    'ls; rm x',
    'find . -name "*.log" -delete',
    'find . -exec rm {} \;',
    'sed -i s/a/b/ file',
    'echo $(rm -rf /)',
    'echo `whoami`',
    'cat x | sh',
    'cat x | xargs rm',
    'sleep 100 &',
    'curl https://example.com',
    'awk \'{system("rm x")}\' f',
    'git stash',
    'git tag v1',
  ])('still asks: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false);
  });

  it('never auto-approves background processes', () => {
    expect(needsNoApproval({ type: 'tool_call', id: '1', name: 'bash', input: { command: 'ls', background: true } })).toBe(false);
    expect(needsNoApproval({ type: 'tool_call', id: '1', name: 'bash', input: { command: 'ls' } })).toBe(true);
    expect(needsNoApproval({ type: 'tool_call', id: '1', name: 'write_file', input: { path: 'x', content: '' } })).toBe(false);
  });

  it('unwraps shell -c wrappers for display and judging', () => {
    expect(unwrapShell('/bin/zsh -lc "git status"')).toBe('git status');
    expect(unwrapShell("bash -c 'ls -la'")).toBe('ls -la');
    expect(unwrapShell('git status')).toBe('git status');
  });
});
