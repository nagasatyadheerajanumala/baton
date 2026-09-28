import { type Config, type ProviderConfig, resolveApiKey } from '../config/config.js';
import type { AssistantTurn } from '../ir/types.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIChatAdapter } from './openai.js';
import { OpenAIResponsesAdapter } from './openai-responses.js';
import { ClaudeCodeAdapter } from './cli/claude-code.js';
import { CodexAdapter } from './cli/codex.js';
import type { ProviderAdapter } from './types.js';

/**
 * Stands in for a provider whose API key isn't set. Constructing the real SDK
 * client would throw (OpenAI) or fail later with an unclassifiable error
 * (Anthropic); instead every call fails as an auth error, so the router skips
 * this target and the rest of the chain keeps working.
 */
export class MissingKeyAdapter implements ProviderAdapter {
  get label(): string {
    return `${this.name} (no key)`;
  }
  constructor(
    readonly name: string,
    readonly envName: string,
  ) {}
  async complete(): Promise<AssistantTurn> {
    throw Object.assign(new Error(`No API key for "${this.name}": ${this.envName} is not set`), { status: 401 });
  }
}

export const keyEnvName = (name: string, p: ProviderConfig) =>
  p.apiKeyEnv ?? (p.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : p.type === 'openai' ? 'OPENAI_API_KEY' : `${name.toUpperCase()}_API_KEY`);

/** Instantiate one adapter per configured provider that the chain uses. */
export function buildAdapters(config: Config, env: NodeJS.ProcessEnv = process.env): Map<string, ProviderAdapter> {
  const used = new Set(config.chain.map((t) => t.provider));
  const adapters = new Map<string, ProviderAdapter>();
  for (const name of used) {
    const p = config.providers[name]!;
    if (p.type === 'claude-code') {
      adapters.set(name, new ClaudeCodeAdapter({ name, command: p.command }));
      continue;
    }
    if (p.type === 'codex') {
      adapters.set(name, new CodexAdapter({ name, command: p.command, env }));
      continue;
    }
    const apiKey = resolveApiKey(p, env);
    // Local OpenAI-compatible servers (Ollama, vLLM) usually need no key.
    if (!apiKey && p.type !== 'openai-compatible') {
      adapters.set(name, new MissingKeyAdapter(name, keyEnvName(name, p)));
      continue;
    }
    const common = { name, apiKey, baseURL: p.baseURL, headers: p.headers };
    adapters.set(
      name,
      p.type === 'anthropic'
        ? new AnthropicAdapter(common)
        : p.type === 'openai'
          ? new OpenAIResponsesAdapter({ ...common, reasoningEffort: p.reasoningEffort })
          : new OpenAIChatAdapter({ ...common, maxTokensParam: p.maxTokensParam }),
    );
  }
  for (const [name, adapter] of adapters) {
    const label = config.providers[name]?.label;
    if (label) Object.defineProperty(adapter, 'label', { value: label, configurable: true });
  }
  return adapters;
}
