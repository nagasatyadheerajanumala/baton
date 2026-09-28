import { describe, expect, it } from 'vitest';
import { classifyError } from '../src/router/errors.js';
import { AllTargetsExhaustedError, Router, type Target } from '../src/router/router.js';
import { ScriptedAdapter, apiError, quotaError, text } from './helpers.js';

const T = (provider: string, model = 'm'): Target => ({ provider, model, contextWindow: 100_000, maxOutputTokens: 1_000 });
const prepare = () => ({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 });

describe('classifyError', () => {
  it.each([
    [quotaError(), 'quota'],
    [apiError(400, 'Your credit balance is too low to access the Anthropic API.'), 'quota'],
    [apiError(402, 'Insufficient credits'), 'quota'],
    [apiError(429, 'Rate limit reached for requests', undefined, { 'retry-after': '3' }), 'rate_limit'],
    [apiError(529, 'Overloaded'), 'overloaded'],
    [apiError(503, 'Service Unavailable'), 'overloaded'],
    [apiError(400, "This model's maximum context length is 128000 tokens", { error: { code: 'context_length_exceeded' } }), 'context_length'],
    [apiError(400, 'prompt is too long: 210000 tokens > 200000 maximum'), 'context_length'],
    [apiError(401, 'invalid x-api-key'), 'auth'],
    [apiError(400, 'tools.0.name: String should match pattern'), 'fatal'],
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'network'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'aborted'],
  ])('%s -> %s', (err, kind) => {
    expect(classifyError(err).kind).toBe(kind);
  });

  it('reads retry-after in seconds and ms', () => {
    expect(classifyError(apiError(429, 'slow down', undefined, { 'retry-after': '7' })).retryAfterMs).toBe(7_000);
    expect(classifyError(apiError(429, 'slow down', undefined, { 'retry-after-ms': '250' })).retryAfterMs).toBe(250);
  });
});

describe('Router', () => {
  const noSleep = { sleep: async () => {} };

  it('waits and retries the same target on a short rate limit', async () => {
    const a = new ScriptedAdapter('a', [apiError(429, 'rate limited', undefined, { 'retry-after': '1' }), text('ok')]);
    const waits: number[] = [];
    const r = new Router([T('a'), T('b')], new Map([['a', a], ['b', new ScriptedAdapter('b', [])]]), noSleep);
    const res = await r.complete(prepare, { onRetry: (_t, ms) => waits.push(ms) });
    expect(res.target.provider).toBe('a');
    expect(waits).toEqual([1_000]);
  });

  it('fails over immediately on quota, then stays on the new target (sticky)', async () => {
    const a = new ScriptedAdapter('a', [quotaError()]);
    const b = new ScriptedAdapter('b', [text('one'), text('two')]);
    let now = 0;
    const r = new Router([T('a'), T('b')], new Map([['a', a], ['b', b]]), { ...noSleep, now: () => now });
    expect((await r.complete(prepare)).target.provider).toBe('b');
    now += 2 * 60 * 60_000; // a's cooldown has long expired
    expect((await r.complete(prepare)).target.provider).toBe('b');
    expect(a.requests).toHaveLength(1);
  });

  it('fails over when the provider asks for a wait longer than we tolerate', async () => {
    const a = new ScriptedAdapter('a', [apiError(429, 'rate limited', undefined, { 'retry-after': '120' })]);
    const b = new ScriptedAdapter('b', [text('ok')]);
    const r = new Router([T('a'), T('b')], new Map([['a', a], ['b', b]]), noSleep);
    expect((await r.complete(prepare)).target.provider).toBe('b');
  });

  it('shrinks the budget and retries the same target on context overflow', async () => {
    const scales: number[] = [];
    const a = new ScriptedAdapter('a', [apiError(400, 'prompt is too long'), text('ok')]);
    const r = new Router([T('a')], new Map([['a', a]]), noSleep);
    await r.complete((_t, s) => {
      scales.push(s);
      return prepare();
    });
    expect(scales).toEqual([1, 0.6]);
  });

  it('surfaces fatal errors instead of masking them with failover', async () => {
    const a = new ScriptedAdapter('a', [apiError(400, 'invalid tool schema')]);
    const b = new ScriptedAdapter('b', [text('ok')]);
    const r = new Router([T('a'), T('b')], new Map([['a', a], ['b', b]]), noSleep);
    await expect(r.complete(prepare)).rejects.toThrow('invalid tool schema');
    expect(b.requests).toHaveLength(0);
  });

  it('reports every failure when the whole chain is exhausted', async () => {
    const r = new Router(
      [T('a'), T('b')],
      new Map([['a', new ScriptedAdapter('a', [quotaError()])], ['b', new ScriptedAdapter('b', [apiError(401, 'bad key')])]]),
      noSleep,
    );
    const err = await r.complete(prepare).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllTargetsExhaustedError);
    expect((err as AllTargetsExhaustedError).failures.map((f) => f.why.kind)).toEqual(['quota', 'auth']);
  });

  it('skips a cooled-down current target at the start of a call', async () => {
    const a = new ScriptedAdapter('a', [quotaError()]);
    const b = new ScriptedAdapter('b', [text('1')]);
    const c = new ScriptedAdapter('c', [text('2')]);
    const r = new Router([T('a'), T('b'), T('c')], new Map([['a', a], ['b', b], ['c', c]]), noSleep);
    await r.complete(prepare); // a -> b
    r.setCurrent('c');
    expect((await r.complete(prepare)).target.provider).toBe('c');
  });
});
