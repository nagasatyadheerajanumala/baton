import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Config, saveModelChoice, toTargets } from '../src/config/config.js';
import { CLAUDE_MODELS, codexModels } from '../src/config/models.js';
import { Router } from '../src/router/router.js';
import { switchModel } from '../src/ui/commands.js';
import { ScriptedAdapter } from './helpers.js';

function codexHome() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-6-sol', description: 'Workhorse model for coding.', visibility: 'list', priority: 2, context_window: 272000 },
      { slug: 'gpt-6-astra', description: 'Frontier intelligence.', visibility: 'list', priority: 1, context_window: 272000 },
      { slug: 'codex-auto-review', description: 'internal', visibility: 'hide', priority: 43, context_window: 272000 },
    ],
  }));
  return dir;
}

describe('model catalog', () => {
  it("reads the ChatGPT plan's models from Codex's own cache, hiding internal ones", () => {
    const models = codexModels({ CODEX_HOME: codexHome() });
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(models[1]).toEqual({ id: 'gpt-6-sol', description: 'workhorse model for coding', contextWindow: 272000 });
  });

  it('gives every account its full model list and the real context window of a plan', () => {
    const config: Config = {
      providers: { chatgpt: { type: 'codex' }, claude: { type: 'claude-code' } },
      // 922000 was what `baton init` used to write for Codex; the plan's CLI window is 272k.
      chain: [{ provider: 'chatgpt', model: 'gpt-6-sol', contextWindow: 922000 }, { provider: 'claude', model: 'claude-opus-5-5' }],
    };
    const [chatgpt, claude] = toTargets(config, { CODEX_HOME: codexHome() });
    expect(chatgpt!.contextWindow).toBe(272000);
    expect(chatgpt!.models!.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(claude!.models!.map((m) => m.id)).toEqual(CLAUDE_MODELS.map((m) => m.id));
    expect(claude!.contextWindow).toBe(1_000_000);
  });

  it('switches to any model on any account by name, updating its context window', () => {
    const config: Config = { providers: { chatgpt: { type: 'codex' }, claude: { type: 'claude-code' } }, chain: [{ provider: 'chatgpt', model: 'gpt-6-astra' }, { provider: 'claude', model: 'claude-opus-5-5' }] };
    const router = new Router(toTargets(config, { CODEX_HOME: codexHome() }), new Map([['chatgpt', new ScriptedAdapter('chatgpt', [])], ['claude', new ScriptedAdapter('claude', [])]]));
    expect(switchModel(router, 'claude-haiku-4-5')).toMatchObject({ provider: 'claude', model: 'claude-haiku-4-5', contextWindow: 200_000 });
    expect(router.current.model).toBe('claude-haiku-4-5');
    expect(switchModel(router, 'sol')).toMatchObject({ provider: 'chatgpt', model: 'gpt-6-sol' }); // unique partial match
    expect(() => switchModel(router, 'gpt-6')).toThrow(/matches gpt-6-astra, gpt-6-sol/);
  });

  it('saves the choice as the account default in the config file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'baton-cfg-')), 'config.json');
    writeFileSync(file, JSON.stringify({ providers: { claude: { type: 'claude-code' } }, chain: [{ provider: 'claude', model: 'claude-opus-5-5', contextWindow: 1000000 }] }));
    expect(saveModelChoice(file, 'claude', 'claude-sonnet-5-5')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).chain[0]).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });
});
