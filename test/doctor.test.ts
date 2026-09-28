import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config/config.js';
import { runDoctor } from '../src/doctor.js';
import { FakeProviders, aText, aThinking, aToolUse, anthropicStream, json, rCall, rMessage, rReasoning, responsesStream } from './fake-providers.js';

const fake = new FakeProviders();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('baton doctor', () => {
  it('verifies working models with a real tool loop and explains each kind of failure', async () => {
    // openai (Responses): works, with reasoning replay
    fake.on(
      '/v1/responses',
      (_b, res) => responsesStream(res, [rReasoning('rs_1', 'ENC'), rCall('c1', 'echo', { text: 'baton' })]),
      (_b, res) => responsesStream(res, [rMessage('OK')], { text: 'OK' }),
    );
    // Anthropic-protocol providers share /v1/messages; doctor checks the chain in order.
    fake.on(
      '/v1/messages',
      (_b, res) => anthropicStream(res, [aThinking('SIG'), aToolUse('toolu_1', 'echo', { text: 'baton' })], 'tool_use'), // claude ok, step 1
      (_b, res) => anthropicStream(res, [aThinking('SIG2'), aText('OK')], 'end_turn'), //                                claude ok, step 2
      (_b, res) => json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), // badkey
      (_b, res) => json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), // broke
    );
    // openai-compatible server that doesn't have the model; doctor lists what it does have.
    fake.on('/v1/chat/completions', (_b, res) => json(res, 404, { error: { message: 'The model `qwen-typo` does not exist', code: 'model_not_found' } }));
    fake.on('/v1/models', (_b, res) => json(res, 200, { object: 'list', data: [{ id: 'qwen2.5-coder:32b', object: 'model' }, { id: 'llama3', object: 'model' }] }));

    const config: Config = {
      providers: {
        openai: { type: 'openai', apiKey: 'sk-test', baseURL: `${fake.base}/v1` },
        claude: { type: 'anthropic', apiKey: 'sk-ant', baseURL: fake.base },
        badkey: { type: 'anthropic', apiKey: 'sk-bad', baseURL: fake.base },
        broke: { type: 'anthropic', apiKey: 'sk-broke', baseURL: fake.base },
        local: { type: 'openai-compatible', apiKey: 'x', baseURL: `${fake.base}/v1` },
        anthropic: { type: 'anthropic', apiKeyEnv: 'BATON_TEST_MISSING_KEY' },
      },
      chain: [
        { provider: 'openai', model: 'gpt-test' },
        { provider: 'claude', model: 'claude-test' },
        { provider: 'badkey', model: 'claude-test' },
        { provider: 'broke', model: 'claude-test' },
        { provider: 'local', model: 'qwen-typo' },
        { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      ],
    };

    const lines: string[] = [];
    const code = await runDoctor(config, 'test', (s) => lines.push(strip(s)), {});
    const out = lines.join('\n');

    expect(code).toBe(1);
    expect(out).toMatch(/✓ openai\/gpt-test\n\s+auth ok · tool call ok · follow-up ok/);
    expect(out).toMatch(/openai\/gpt-test[\s\S]*reasoning: 1 block\(s\) replayed/);
    expect(out).toMatch(/✓ claude\/claude-test/);
    expect(out).toMatch(/✗ badkey\/claude-test\n\s+API key rejected/);
    expect(out).toMatch(/✗ broke\/claude-test\n\s+No API credits[\s\S]*add credits: https:\/\/platform\.claude\.com\/settings\/billing|✗ broke\/claude-test\n\s+No API credits[\s\S]*does not include API credits/);
    expect(out).toContain('a subscription does not include API credits');
    expect(out).toMatch(/✗ local\/qwen-typo\n\s+Model "qwen-typo" not available[\s\S]*available: qwen2\.5-coder:32b/);
    expect(out).toMatch(/✗ anthropic\/claude-sonnet-5-5\n\s+no API key: BATON_TEST_MISSING_KEY is not set\n\s+create one: https:\/\/platform\.claude\.com\/settings\/keys/);
    expect(out).toContain('2 of 6 models ready');

    // The follow-up request replayed OpenAI's reasoning, proving the multi-step path works.
    const second = fake.requestsTo('/v1/responses')[1] as { input: Array<{ type?: string }> };
    expect(second.input.some((i) => i.type === 'reasoning')).toBe(true);
  });

  it('exits 0 when every model is ready', async () => {
    fake.on('/v1/messages',
      (_b, res) => anthropicStream(res, [aToolUse('t', 'echo', { text: 'baton' })], 'tool_use'),
      (_b, res) => anthropicStream(res, [aText('OK')], 'end_turn'),
    );
    const code = await runDoctor(
      { providers: { a: { type: 'anthropic', apiKey: 'k', baseURL: fake.base } }, chain: [{ provider: 'a', model: 'm' }] },
      'test',
      () => {},
      {},
    );
    expect(code).toBe(0);
  });

  it('reports a missing OpenAI key instead of crashing (the OpenAI SDK throws without one)', async () => {
    const lines: string[] = [];
    const code = await runDoctor(
      { providers: { openai: { type: 'openai', apiKeyEnv: 'OPENAI_API_KEY' } }, chain: [{ provider: 'openai', model: 'gpt-6-sol' }] },
      'test',
      (s) => lines.push(strip(s)),
      {},
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/no API key: OPENAI_API_KEY is not set\n\s+create one: https:\/\/platform\.openai\.com\/api-keys/);
  });

  it('explains how to start when nothing is configured', async () => {
    const lines: string[] = [];
    expect(await runDoctor({ providers: {}, chain: [] }, 'env', (s) => lines.push(strip(s)), {})).toBe(1);
    expect(lines.join('\n')).toContain('Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY');
  });
});
