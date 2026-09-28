# baton
Coding-agent harness that hot-swaps LLM providers mid-session without losing context.

Hit a rate limit or run out of quota halfway through a task, and baton hands the conversation to the next model in your chain: same history, same tool results, same files on disk. The new model is told it is taking over and gets a fresh `git status`, so it continues instead of starting over.

```
› make greet() say hello, world
  → read src/greet.ts
  → edit src/greet.ts
  ⇄ openai/gpt-5 unavailable (quota) → switching to anthropic/claude-sonnet-5, context preserved
  → $ npm test
Done: greet() now returns "hello, world" and the tests pass.
```

## Features

- **Provider-neutral conversation state.** One internal message format; adapters translate to Anthropic's `tool_use`/`tool_result` and OpenAI's `tool_calls`/`tool` messages.
- **Automatic failover.** Short rate limits wait and retry; exhausted quota, bad keys and outages switch to the next model. Real request bugs are surfaced, never hidden by switching.
- **Deterministic context compaction.** When the next model has a smaller window, stale file reads are collapsed, old tool output is trimmed, and older turns become a state summary. The original task is always kept, and the saved session keeps full history.
- **Local tool engine.** read/write/edit files, search, bash, git status. Changes require approval (or `--approval auto-edit` / `--yes`).
- **Resumable sessions.** Every session is an append-only log in `~/.baton/sessions/`; pick up with `--continue` or `--resume <id>`.

Supported providers: Anthropic, OpenAI, and anything OpenAI-compatible (OpenRouter, LiteLLM, Ollama, vLLM).

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/nagasatyadheerajanumala/baton.git
cd baton && npm install && npm run build && npm link
export OPENAI_API_KEY=...        # any combination of keys works
export ANTHROPIC_API_KEY=...
baton                            # interactive
baton -p "explain src/index.ts"  # one-shot
```

With no config file, baton builds its chain from the keys it finds (OpenAI first, then Anthropic). For full control, copy [`baton.config.example.json`](baton.config.example.json) to `baton.config.json` (per project) or `~/.baton/config.json`. The `chain` array is your failover order. Check the model ids against your providers' current model lists.

## Commands

| | |
|---|---|
| `/model` | show the chain and cooldowns; `/model <name>` switches manually |
| `/status` | session id, token usage, switches so far, files modified |
| `/compact` | preview what compaction would do for the current model |
| `/exit` | quit; the session is saved |

## Development

```bash
npm test            # unit, end-to-end hot-swap, and real-SDK wire tests (no API keys needed)
npm run typecheck
npm run dev -- -p "prompt"
```

See [AGENTS.md](AGENTS.md) for architecture and the invariants the code relies on.

## Status

Early (v0.1). Not yet supported: logging in with Claude/ChatGPT subscription accounts instead of API keys, LLM-written summaries for compaction, and a richer terminal UI.
