import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolCallBlock } from '../src/ir/types.js';
import { ToolEngine } from '../src/tools/registry.js';

const engine = new ToolEngine();
const dir = () => mkdtempSync(join(tmpdir(), 'baton-tools-'));
const call = (name: string, input: Record<string, unknown>): ToolCallBlock => ({ type: 'tool_call', id: 'c1', name, input });
const ctx = (cwd: string, approve: (s: string) => Promise<boolean> = async () => true) => ({ cwd, approve });

describe('ToolEngine', () => {
  it('edit_file requires a unique match', async () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'f.txt'), 'a\nb\na\n');
    const dup = await engine.run(call('edit_file', { path: 'f.txt', old_string: 'a', new_string: 'z' }), ctx(cwd));
    expect(dup.isError).toBe(true);
    expect(dup.content).toContain('occurs 2 times');
    const ok = await engine.run(call('edit_file', { path: 'f.txt', old_string: 'b', new_string: 'z' }), ctx(cwd));
    expect(ok.isError).toBeUndefined();
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('a\nz\na\n');
  });

  it('edit_file treats $ in new_string literally', async () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'f.txt'), 'price');
    await engine.run(call('edit_file', { path: 'f.txt', old_string: 'price', new_string: "$& $1 $$" }), ctx(cwd));
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('$& $1 $$');
  });

  it('refuses writes outside the project root', async () => {
    const r = await engine.run(call('write_file', { path: '../escape.txt', content: 'x' }), ctx(dir()));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('outside the project root');
  });

  it('asks for approval on mutating tools and respects denial', async () => {
    const cwd = dir();
    const asked: string[] = [];
    const r = await engine.run(call('bash', { command: 'touch nope' }), ctx(cwd, async (s: string) => (asked.push(s), false)));
    expect(asked).toEqual(['$ touch nope']);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('denied');
  });

  it('does not ask for approval on read-only tools', async () => {
    const cwd = dir();
    writeFileSync(join(cwd, 'r.txt'), 'one\ntwo\nthree');
    const r = await engine.run(call('read_file', { path: 'r.txt', offset: 2, limit: 1 }), ctx(cwd, async () => {
      throw new Error('should not ask');
    }));
    expect(r.content).toBe('2\ttwo\n\n[1 more lines; continue with offset=3]');
  });

  it('reports bash exit codes and marks failures as errors', async () => {
    const r = await engine.run(call('bash', { command: 'echo out; echo err >&2; exit 3' }), ctx(dir()));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('out');
    expect(r.content).toContain('err');
    expect(r.content).toContain('[exit 3]');
  });

  it('kills commands that exceed their timeout', async () => {
    const r = await engine.run(call('bash', { command: 'sleep 5', timeout_ms: 200 }), ctx(dir()));
    expect(r.content).toContain('timed out');
  });

  it('turns bad input into readable errors instead of throwing', async () => {
    const cwd = dir();
    expect((await engine.run(call('nope', {}), ctx(cwd))).content).toContain('Unknown tool');
    expect((await engine.run(call('read_file', {}), ctx(cwd))).content).toContain('Missing required');
    expect((await engine.run(call('bash', { __unparsed_arguments: '{bad' }), ctx(cwd))).content).toContain('not valid JSON');
    expect((await engine.run(call('read_file', { path: 'missing.txt' }), ctx(cwd))).content).toContain('ENOENT');
  });
});
