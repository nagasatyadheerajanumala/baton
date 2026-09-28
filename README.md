# baton
Coding-agent harness that hot-swaps LLM providers mid-session without losing context.

Hit a rate limit or run out of quota halfway through a task, and baton hands the conversation to the next model in your chain: same history, same tool results, same files on disk. The new model is told it is taking over and gets a fresh `git status`, so it continues instead of starting over.

```
› make greet() say hello, world
  → read src/greet.ts
  → edit src/greet.ts
  ⇄ openai/gpt-6-sol unavailable (quota) → switching to anthropic/claude-sonnet-5-5, context preserved
  → $ npm test
Done: greet() now returns "hello, world" and the tests pass.
```

## Features

- **Provider-neutral conversation state.** One internal message format; adapters translate to Anthropic's Messages API, OpenAI's Responses API, and Chat Completions for OpenAI-compatible servers.
- **Reasoning kept intact.** Claude's signed thinking blocks and OpenAI's encrypted reasoning are sent back to the model that produced them during tool loops (both vendors require this), and never leak to a different model after a switch.
- **Automatic failover.** Short rate limits wait and retry; exhausted quota, bad keys and outages switch to the next model. Real request bugs are surfaced, never hidden by switching.
- **Deterministic context compaction.** When the next model has a smaller window, stale file reads are collapsed, old tool output is trimmed, and older turns become a state summary. The original task is always kept, and the saved session keeps full history.
- **Local tool engine.** read/write/edit files, search, bash, git status. Changes require approval (or `--approval auto-edit` / `--yes`).
- **Resumable sessions.** Every session is an append-only log in `~/.baton/sessions/`; pick up with `--continue` or `--resume <id>`.

Supported providers: OpenAI, Anthropic, and anything OpenAI-compatible (OpenRouter, LiteLLM, Ollama, vLLM).

## Quick start

Requires Node 20+ and an **API key** from at least one provider. ChatGPT Plus/Pro and Claude Pro/Max subscriptions don't include API access; see the [setup guide](docs/SETUP.md) for getting keys and credits.

```bash
git clone https://github.com/nagasatyadheerajanumala/baton.git
cd baton && npm install && npm link   # npm install also builds; npm link puts `baton` on your PATH
export OPENAI_API_KEY=sk-...          # any combination of keys works
export ANTHROPIC_API_KEY=sk-ant-...
baton doctor                          # verifies each model with a real tool call
baton                                 # interactive
baton -p "explain src/index.ts"       # one-shot
```

With no config file, baton builds its chain from the keys it finds (OpenAI `gpt-6-sol` first, then Claude `claude-sonnet-5-5`). Run `baton init` to write `~/.baton/config.json` and choose your own order and models; [`docs/SETUP.md`](docs/SETUP.md) covers every option.

## Commands

| | |
|---|---|
| `/model` | show the chain and cooldowns; `/model <name>` switches manually |
| `/status` | session id, token usage, switches so far, files modified |
| `/compact` | preview what compaction would do for the current model |
| `/exit` | quit; the session is saved |

| CLI | |
|---|---|
| `baton doctor` | check keys, credits, model ids, tool calling and reasoning replay for every model in the chain |
| `baton init` | write a starter `~/.baton/config.json` |
| `baton --continue` / `--resume <id>` | resume a saved session |

## Development

```bash
npm test            # unit, end-to-end hot-swap, and real-SDK wire tests against a fake server (no API keys needed)
npm run typecheck
npm run dev -- -p "prompt"
```

See [AGENTS.md](AGENTS.md) for architecture and the invariants the code relies on.

## Status

Early (v0.1). Not yet supported: logging in with Claude/ChatGPT subscription accounts instead of API keys, LLM-written summaries for compaction, and a richer terminal UI.
