import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/loop.js';
import { expandCommand, loadCommands, loadSkills, parseFrontmatter, skillsPrompt } from '../src/agent/extensions.js';
import { type HookSource, HookRunner, claudeToolView } from '../src/agent/hooks.js';
import { Session } from '../src/ir/session.js';
import { Router } from '../src/router/router.js';
import { ProcessManager } from '../src/tools/processes.js';
import { ToolEngine } from '../src/tools/registry.js';
import { ScriptedAdapter, text, toolCall } from './helpers.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
function repo() {
  const root = tmp('baton-ext-');
  mkdirSync(join(root, '.git'));
  return root;
}
const env = (root: string) => ({ BATON_HOME: join(root, 'no-baton-home'), CODEX_HOME: join(root, 'no-codex-home') });

describe('frontmatter', () => {
  it('reads scalars, quoted values, folded blocks and lists', () => {
    const { data, body } = parseFrontmatter(`---\nname: deploy\ndescription: >\n  Ship it to prod\n  safely.\nargument-hint: "[env]"\nallowed-tools:\n  - Bash\n  - Read\n---\nBody here`);
    expect(data).toEqual({ name: 'deploy', description: 'Ship it to prod safely.', 'argument-hint': '[env]', 'allowed-tools': ['Bash', 'Read'] });
    expect(body).toBe('Body here');
  });
});

describe('skills and custom commands', () => {
  it('finds project skills in .claude/.agents/.codex skills folders and lists them for the model', () => {
    const root = repo();
    for (const [dir, name] of [['.claude/skills', 'release'], ['.agents/skills', 'triage']] as const) {
      mkdirSync(join(root, dir, name), { recursive: true });
      writeFileSync(join(root, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Do the ${name} dance\n---\nStep 1.`);
    }
    const skills = loadSkills(root, env(root));
    const mine = skills.filter((s) => s.origin === 'project').map((s) => s.name).sort();
    expect(mine).toEqual(['release', 'triage']);
    expect(skillsPrompt(skills)).toContain('- release: Do the release dance');
  });

  it('runs a command with $ARGUMENTS, $1 and inline shell, like Claude Code', async () => {
    const root = repo();
    mkdirSync(join(root, '.claude', 'commands', 'ops'), { recursive: true });
    writeFileSync(join(root, '.claude', 'commands', 'ops', 'deploy.md'), '---\ndescription: Deploy a service\nargument-hint: <service> <env>\n---\nDeploy $1 to $2. Full request: $ARGUMENTS\nBranch: !`echo main`');
    const cmd = loadCommands(root, env(root)).find((c) => c.name === 'deploy')!;
    expect(cmd).toMatchObject({ origin: 'project', argumentHint: '<service> <env>', description: 'Deploy a service (ops)' });
    const prompt = await expandCommand(cmd, 'api "prod eu"', async (c) => (c === 'echo main' ? 'main\n' : ''));
    expect(prompt).toBe('Deploy api to prod eu. Full request: api "prod eu"\nBranch: main');
  });

  it('the skill tool loads full instructions on demand', async () => {
    const root = repo();
    mkdirSync(join(root, '.claude', 'skills', 'release'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\n1. Bump version\n2. Tag');
    const r = await new ToolEngine().run({ type: 'tool_call', id: 's', name: 'skill', input: { name: 'release' } }, { cwd: root, approve: async () => true, processes: new ProcessManager() });
    expect(r.content).toContain('1. Bump version');
    expect(r.content).toContain(join(root, '.claude', 'skills', 'release'));
  });
});

// ---- hooks ----------------------------------------------------------------------------------

function runner(cwd: string, hooks: HookSource['hooks'], opts: { project?: boolean; trusted?: boolean } = {}) {
  return new HookRunner(cwd, 'sess-1', '', [{ path: 'x', label: 'test', project: opts.project ?? false, hooks }], opts.trusted ?? false);
}
const ctx = (cwd: string, hooks: HookRunner, approve: (s: string) => Promise<boolean> = async () => true) => ({ cwd, approve, processes: new ProcessManager(), hooks });

describe('hooks (Claude Code format)', () => {
  it('maps baton tools to Claude names so existing matchers work', () => {
    expect(claudeToolView({ type: 'tool_call', id: '1', name: 'edit_file', input: { path: 'a.ts', old_string: 'x', new_string: 'y' } }))
      .toEqual({ name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: false } });
  });

  it('PreToolUse: exit 2 blocks the call and tells the model why; JSON "allow" skips the permission prompt', async () => {
    const cwd = tmp('baton-hk-');
    const engine = new ToolEngine();
    const block = runner(cwd, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'grep -q "rm -rf" && { echo "no rm -rf here" >&2; exit 2; } || exit 0' }] }] });
    const r = await engine.run({ type: 'tool_call', id: '1', name: 'bash', input: { command: 'rm -rf build' } }, ctx(cwd, block));
    expect(r).toMatchObject({ isError: true, content: expect.stringContaining('no rm -rf here') });

    const asked: string[] = [];
    const allow = runner(cwd, { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] });
    const w = await engine.run({ type: 'tool_call', id: '2', name: 'write_file', input: { path: 'ok.txt', content: 'hi' } }, ctx(cwd, allow, async (s) => (asked.push(s), false)));
    expect(asked).toEqual([]); // the hook approved it, no prompt
    expect(w.isError).toBeUndefined();
    expect(readFileSync(join(cwd, 'ok.txt'), 'utf8')).toBe('hi');
  });

  it('PostToolUse feedback reaches the model; the hook sees Claude-style input', async () => {
    const cwd = tmp('baton-hk-');
    const h = runner(cwd, { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `cat > seen.json; echo '{"hookSpecificOutput":{"additionalContext":"lint: 2 warnings"}}'` }] }] });
    const r = await new ToolEngine().run({ type: 'tool_call', id: '1', name: 'write_file', input: { path: 'a.ts', content: 'x' } }, ctx(cwd, h));
    expect(r.content).toContain('[hook feedback] lint: 2 warnings');
    const seen = JSON.parse(readFileSync(join(cwd, 'seen.json'), 'utf8'));
    expect(seen).toMatchObject({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts' }, session_id: 'sess-1' });
  });

  it('UserPromptSubmit can add context or block; Stop can send the model back to work', async () => {
    const cwd = tmp('baton-hk-');
    const hooks = runner(cwd, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "Current sprint: payments"' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'test -f stopped-once && exit 0; touch stopped-once; echo "tests still failing" >&2; exit 2' }] }],
    });
    const model = new ScriptedAdapter('api', [text('first answer'), text('fixed the tests')]);
    const agent = new Agent(new Session(undefined, cwd, { persist: false }), new Router([{ provider: 'api', model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }], new Map([['api', model]])), new ToolEngine(), { cwd, approve: async () => true, hooks });
    const notices: string[] = [];
    await agent.run('fix it', { onNotice: (n) => notices.push(n) });
    expect(model.requests[0]!.messages[0]!.content[0]).toMatchObject({ text: expect.stringContaining('Current sprint: payments') });
    expect(model.requests).toHaveLength(2); // the Stop hook made it keep going once
    expect(notices.join('\n')).toContain('tests still failing');

    const blocker = runner(cwd, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo "contains a secret" >&2; exit 2' }] }] });
    const m2 = new ScriptedAdapter('api', []);
    const a2 = new Agent(new Session(undefined, cwd, { persist: false }), new Router([{ provider: 'api', model: 'm', contextWindow: 100_000, maxOutputTokens: 1_000 }], new Map([['api', m2]])), new ToolEngine(), { cwd, approve: async () => true, hooks: blocker });
    const n2: string[] = [];
    await a2.run('my password is hunter2', { onNotice: (n) => n2.push(n) });
    expect(m2.requests).toHaveLength(0);
    expect(n2[0]).toContain('contains a secret');
  });

  it("doesn't run a project's hooks until the folder is trusted", async () => {
    const cwd = tmp('baton-hk-');
    const h = runner(cwd, { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo nope >&2; exit 2' }] }] }, { project: true, trusted: false });
    expect(h.untrustedProjectHooks).toHaveLength(1);
    expect((await h.preToolUse({ type: 'tool_call', id: '1', name: 'read_file', input: { path: 'x' } })).block).toBeUndefined();
  });
});
