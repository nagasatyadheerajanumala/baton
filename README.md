# baton
Coding-agent harness that hot-swaps LLM providers mid-session without losing context.

Hit a rate limit or run out of quota halfway through a task, and baton hands the conversation to the next model in your chain: same history, same tool results, same files on disk. The new model is told it is taking over and gets a fresh `git status`, so it continues instead of starting over.

![baton's full-screen UI: a session that switched from gpt-6-sol to claude-sonnet-5-5 mid-task, with the process pane showing a running dev server](docs/images/tui.png)

## Features

- **Provider-neutral conversation state.** One internal message format; adapters translate to Anthropic's Messages API, OpenAI's Responses API, and Chat Completions for OpenAI-compatible servers.
- **Reasoning kept intact.** Claude's signed thinking blocks and OpenAI's encrypted reasoning are sent back to the model that produced them during tool loops (both vendors require this), and never leak to a different model after a switch.
- **Automatic failover.** Short rate limits wait and retry; exhausted quota, bad keys and outages switch to the next model. Real request bugs are surfaced, never hidden by switching.
- **Deterministic context compaction.** When the next model has a smaller window, stale file reads are collapsed, old tool output is trimmed, and older turns become a state summary. The original task is always kept, and the saved session keeps full history.
- **Full-screen terminal UI.** Inline diffs, approvals, a live cost and context meter, and a process pane for everything the agent runs: click a process (or `tab` + arrows) to see its live output, `k` to stop it. `--plain` gives a line-based prompt instead.
- **Background processes.** The agent can start dev servers and watchers in the background, check their output, and stop them. After a provider switch, the new model is told what's still running.
- **Local tool engine.** read/write/edit files, search, bash, git status. Changes require approval (or `--approval auto-edit` / `--yes`).
- **Resumable sessions.** Every session is an append-only log in `~/.baton/sessions/`; pick up with `--continue` or `--resume <id>`.

Works with your **Claude Pro/Max and ChatGPT subscriptions** (through the official Claude Code and Codex CLIs, which you sign in to yourself), **API keys** for OpenAI and Anthropic, and anything OpenAI-compatible (OpenRouter, LiteLLM, Ollama, vLLM). Mix them: plans first, API keys as overflow.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/nagasatyadheerajanumala/baton.git
cd baton && npm install && npm link   # npm install also builds; npm link puts `baton` on your PATH

claude auth login                     # Claude Pro/Max (official Claude Code CLI)
codex login                           # ChatGPT plan (official Codex CLI)
export ANTHROPIC_API_KEY=sk-ant-...   # optional: API keys as overflow

baton init                            # finds your signed-in plans and keys, writes the failover chain
baton doctor                          # verifies each one with a real tool call
baton                                 # start
```

baton never sees your subscription logins; the official CLIs handle them. [`docs/SETUP.md`](docs/SETUP.md) covers every option.

## Keys and commands

| Key | |
|---|---|
| `^P` or click `⚙ N running` | open/close the process pane |
| `tab` | move focus between the prompt and the process pane |
| `↑↓` `↵` `k` `c` | in the pane: select, expand output, stop, clear finished |
| `esc` | collapse / close the pane |
| `PgUp` `PgDn`, mouse wheel | scroll the conversation or process output |
| `^C` | interrupt the current turn (or clear the prompt) |
| `^D` | exit (asks first if processes are still running) |
| `!cmd` | run a shell command yourself; it shows up in the pane |

Mouse capture blocks your terminal's native text selection; hold `Option` (iTerm2, Terminal.app) to select text, or start with `--no-mouse`.

| Command | |
|---|---|
| `/model` | show the chain and cooldowns; `/model <name>` switches manually |
| `/status` | session id, token usage and cost, switches so far, files modified |
| `/compact` | preview what compaction would do for the current model |
| `/clear` | clear the screen (the session keeps its history) |
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

See [AGENTS.md](AGENTS.md) for architecture and the invariants the code relies on, and [docs/ROADMAP.md](docs/ROADMAP.md) for what's planned: parity with Claude Code and Codex CLI, plus what only a multi-provider harness can do.

## Status

Early (v0.1). See the [roadmap](docs/ROADMAP.md).
