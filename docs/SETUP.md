# Setting up baton

baton talks to model providers through their **APIs**, using API keys. You need at least one provider; two or more is what makes failover useful.

> **Subscriptions are not API access.** ChatGPT Plus/Pro and Claude Pro/Max are chat subscriptions. They do not include API credits, and baton cannot use them. API usage is billed separately, pay-as-you-go, on each provider's developer platform.

## 1. Install

Requires Node.js 20 or newer (`node --version`).

```bash
npm install -g github:nagasatyadheerajanumala/baton
```

Or from a clone:

```bash
git clone https://github.com/nagasatyadheerajanumala/baton.git
cd baton
npm install        # also builds
npm link           # puts `baton` on your PATH
```

## 2. Get API keys

### OpenAI

1. Sign in at <https://platform.openai.com>. This is a separate account area from ChatGPT, though you can use the same login.
2. Add a payment method and buy credits: <https://platform.openai.com/account/billing/overview>. New accounts get `insufficient_quota` errors until billing is set up.
3. Create a key: <https://platform.openai.com/api-keys>. Copy it now; it's only shown once.

### Anthropic (Claude)

1. Sign in at <https://platform.claude.com> (the Claude Console, formerly console.anthropic.com). This is separate from claude.ai.
2. Add credits: <https://platform.claude.com/settings/billing>. Without credits, requests fail with "Your credit balance is too low".
3. Create a key: <https://platform.claude.com/settings/keys>.

### Optional: OpenRouter or a local model

- **OpenRouter** gives one key for many models: <https://openrouter.ai/settings/keys>.
- **Ollama** runs models locally for free (no key, but weak tool calling; best as a last-resort fallback): install from <https://ollama.com/download>, then `ollama pull qwen2.5-coder:32b`.

## 3. Give baton your keys

Put keys in environment variables, not in files you might commit. For zsh (the macOS default):

```bash
echo 'export OPENAI_API_KEY="sk-..."' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

(bash: use `~/.bashrc`. fish: `set -Ux OPENAI_API_KEY sk-...`.)

That's enough to start: with no config file, baton builds its chain from whichever keys it finds, OpenAI first, then Claude.

## 4. Choose your failover chain (optional)

```bash
baton init          # writes ~/.baton/config.json
```

```json
{
  "approval": "ask",
  "providers": {
    "openai":    { "type": "openai",    "apiKeyEnv": "OPENAI_API_KEY" },
    "anthropic": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "chain": [
    { "provider": "openai",    "model": "gpt-6-sol",         "contextWindow": 922000,  "maxOutputTokens": 32000 },
    { "provider": "anthropic", "model": "claude-sonnet-5-5", "contextWindow": 1000000, "maxOutputTokens": 32000 }
  ]
}
```

- **`chain`** is the failover order. The first entry is where sessions start. To start on Claude and fall back to OpenAI, swap the two entries.
- **`type`**: `openai` (OpenAI's Responses API), `anthropic`, or `openai-compatible` (OpenRouter, LiteLLM, Ollama, vLLM; needs a `baseURL`).
- **`apiKeyEnv`** names the environment variable holding the key. An inline `apiKey` also works but is discouraged.
- **`reasoningEffort`** (type `openai` only): `none` | `low` | `medium` | `high` | `xhigh` | `max`.
- A `baton.config.json` in a project directory overrides `~/.baton/config.json` for that project.

See [`baton.config.example.json`](../baton.config.example.json) for all four provider kinds. Model ids were current as of September 2026; if one is retired, `baton doctor` lists the ids your key can use.

## 5. Verify

```bash
baton doctor
```

For each model in the chain, doctor makes a real two-step tool call (a fraction of a cent) and reports what's wrong in plain terms:

```
✓ openai/gpt-6-sol
    auth ok · tool call ok · follow-up ok (1840 ms, 612 tokens)
    reasoning: 1 block(s) replayed to the model across the tool call
✗ anthropic/claude-sonnet-5-5
    No API credits / quota exhausted.
    add credits: https://platform.claude.com/settings/billing
```

| doctor says | fix |
|---|---|
| `no API key: X is not set` | export the variable (step 3) and open a new terminal |
| `API key rejected` | the key is wrong, revoked, or from a different org/project; create a new one |
| `No API credits / quota exhausted` | add credits on the billing page; a chat subscription doesn't count |
| `Model "…" not available` | change `model` in your config to one of the ids doctor lists |
| `Could not reach …` | network/proxy issue, or for Ollama: run `ollama serve` |

## 6. Use it

```bash
cd your-project
baton                      # interactive
baton -p "add a --verbose flag to the CLI"   # one-shot
baton --continue           # pick up the last session
```

In a session: `/model` shows the chain and cooldowns (and `/model 1` switches manually), `/status` shows token usage and switches so far.

### Approvals

By default baton asks before every file write and shell command. Answer `a` once to allow everything for the rest of the session, or start with:

- `--approval auto-edit`: file edits run without asking, shell commands still ask
- `--yes`: nothing asks (use only in a disposable checkout)

## Costs and limits

- You pay each provider for the tokens you use. `/status` shows the running total reported by the providers.
- A switch sends the whole (possibly compacted) conversation to the new model once, so a switch costs roughly one full-context request on the new provider.
- baton waits and retries on short rate limits, and only switches providers when a model is out of quota, rejecting the key, or down.
