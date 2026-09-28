# Setting up baton

baton can use two kinds of accounts, and you can mix them in one failover chain:

- **Subscriptions** (Claude Pro/Max, ChatGPT Plus/Pro): baton drives the official `claude` and `codex` CLIs, signed in with your plan. Usage counts against your plan, not per-token billing.
- **API keys** (OpenAI Platform, Claude Console): pay-as-you-go. Good as overflow when a plan hits its usage limit.

A typical chain: ChatGPT plan → Claude plan → API key. When one hits its limit, baton hands the session to the next.

## 1. Install

Requires Node.js 20 or newer (`node --version`).

```bash
git clone https://github.com/nagasatyadheerajanumala/baton.git
cd baton
npm install        # also builds
npm link           # puts `baton` on your PATH
```

To update later: `git pull && npm install` in that directory.

To try it without installing: `npx github:nagasatyadheerajanumala/baton doctor`.

(`npm install -g github:…` does **not** work: npm skips build dependencies for global installs from git URLs.)

## 2. Sign in with your subscriptions

baton never sees or stores these logins. The official CLIs handle sign-in themselves, which is what Anthropic's and OpenAI's terms allow. baton just runs the CLIs.

**Claude Pro/Max** (Claude Code CLI):

```bash
npm install -g @anthropic-ai/claude-code   # skip if `claude --version` works
claude auth login                          # sign in with your Claude account
```

**ChatGPT Plus/Pro** (Codex CLI):

```bash
npm install -g @openai/codex               # or: brew install codex
codex login                                # choose "Sign in with ChatGPT"
```

Then let baton find them:

```bash
baton init      # writes ~/.baton/config.json with every signed-in subscription (and any API keys you've set)
```

How it works: when a subscription model is active, its CLI runs the model conversation, and baton supplies the tools (file edits, shell, processes) over a private local MCP connection with the CLI's built-in tools off. Your approvals and the process pane work the same, and every step goes into baton's session log, so a switch keeps the whole history. When baton hands a session *into* a CLI, the history goes as a written transcript, since the CLIs can't accept another model's raw tool calls.

## 3. API keys (optional overflow, or instead of subscriptions)

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

### Give baton your keys

Put keys in environment variables, not in files you might commit. For zsh (the macOS default):

```bash
echo 'export OPENAI_API_KEY="sk-..."' >> ~/.zshrc
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

(bash: use `~/.bashrc`. fish: `set -Ux OPENAI_API_KEY sk-...`.)

That's enough to start: with no config file, baton builds its chain from whichever keys it finds, OpenAI first, then Claude.

## 4. Choose your failover chain

```bash
baton init          # writes ~/.baton/config.json
```

```json
{
  "approval": "ask",
  "providers": {
    "chatgpt":   { "type": "codex" },
    "claude":    { "type": "claude-code" },
    "anthropic": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "chain": [
    { "provider": "chatgpt",   "model": "gpt-6-astra",       "contextWindow": 922000 },
    { "provider": "claude",    "model": "claude-opus-5-5",   "contextWindow": 1000000 },
    { "provider": "anthropic", "model": "claude-sonnet-5-5", "contextWindow": 1000000, "maxOutputTokens": 32000 }
  ]
}
```

- **`chain`** is the failover order. The first entry is where sessions start. To start on Claude and fall back to OpenAI, swap the two entries.
- **`type`**: `codex` (ChatGPT plan via the Codex CLI), `claude-code` (Claude plan via the Claude Code CLI), `openai` (OpenAI API), `anthropic` (Claude API), or `openai-compatible` (OpenRouter, LiteLLM, Ollama, vLLM; needs a `baseURL`).
- **`apiKeyEnv`** names the environment variable holding the key. An inline `apiKey` also works but is discouraged.
- **`reasoningEffort`** (type `openai` only): `none` | `low` | `medium` | `high` | `xhigh` | `max`.
- A `baton.config.json` in a project directory overrides `~/.baton/config.json` for that project.

See [`baton.config.example.json`](../baton.config.example.json) for all four provider kinds. Model ids were current as of September 2026; if one is retired, `baton doctor` lists the ids your key can use.

## 5. MCP servers (optional)

The easiest way: type `/mcp` inside baton. You'll see your servers, the ones already set up in Codex and Claude Code, popular ones, and a search box for the official MCP registry. Pick one and press enter; it connects right away, and remote servers open your browser to sign in once.

MCP servers give every model extra tools (a browser, your issue tracker, design files…). Tools work with every model in your chain, and each call goes through baton's permission prompt unless the server marks the tool read-only.

```bash
baton mcp import                        # lists servers already set up in Codex and Claude Code
baton mcp import playwright linear      # copy the ones you want (or --all)
baton mcp login linear                  # remote servers: sign in once in your browser
baton mcp list                          # check they connect
```

Or add your own:

```bash
baton mcp add playwright -- npx @playwright/mcp@latest
baton mcp add linear --url https://mcp.linear.app/mcp
baton mcp add internal --url https://mcp.example.com/mcp --bearer-env INTERNAL_MCP_TOKEN
```

They're stored under `mcpServers` in your config, in the same format as Claude Code's `.mcp.json`. Sign-in tokens live in `~/.baton/mcp-auth/` (readable only by you); baton never reuses Codex's or Claude Code's tokens. A project's `.mcp.json` is never loaded automatically, since a repo could point it at any command; import it on purpose with `baton mcp import`.

## 6. Verify

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
| `Claude Code isn't signed in` / `Codex isn't signed in` | run `claude auth login` / `codex login` |
| `Your plan's usage limit is reached` | nothing to fix; baton skips it until the limit resets |
| `no API key: X is not set` | export the variable (step 3) and open a new terminal |
| `API key rejected` | the key is wrong, revoked, or from a different org/project; create a new one |
| `No API credits / quota exhausted` | add credits on the billing page; a chat subscription doesn't count |
| `Model "…" not available` | change `model` in your config to one of the ids doctor lists |
| `Could not reach …` | network/proxy issue, or for Ollama: run `ollama serve` |

## 7. Use it

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
