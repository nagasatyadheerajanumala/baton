# baton
Coding-agent harness that hot-swaps LLM providers mid-session without losing context.

Hit a rate limit or run out of quota halfway through a task, and baton hands the conversation to the next model in your chain: same history, same tool results, same files on disk. The new model is told it is taking over and gets a fresh `git status`, so it continues instead of starting over.

![baton mid-session: ChatGPT plan hit its limit, baton switched to the Claude plan and kept going; read-only git commands ran without asking, edits show as diffs, a dev server runs in the background, and a queued follow-up was sent after the first task](docs/images/tui.png)

## Features

- **Provider-neutral conversation state.** One internal message format; adapters translate to Anthropic's Messages API, OpenAI's Responses API, and Chat Completions for OpenAI-compatible servers.
- **Reasoning kept intact.** Claude's signed thinking blocks and OpenAI's encrypted reasoning are sent back to the model that produced them during tool loops (both vendors require this), and never leak to a different model after a switch.
- **Automatic failover.** Short rate limits wait and retry; exhausted quota, bad keys and outages switch to the next model. Real request bugs are surfaced, never hidden by switching.
- **Deterministic context compaction.** When the next model has a smaller window, stale file reads are collapsed, old tool output is trimmed, and older turns become a state summary. The original task is always kept, and the saved session keeps full history.
- **A terminal UI that works like Claude Code and Codex.** The transcript prints into your normal scrollback (scroll, select and search as usual), with a short output preview under every step and `Ctrl+O` for the full output. A clear permission prompt shows the whole command with numbered choices; read-only commands like `git status` or `rg` don't ask. Type follow-ups while it works and they're queued. `/model` shows every model, its account, and when a limited plan comes back. `--fullscreen` gives a split layout with a clickable process pane; `--plain` a line-based prompt.
- **MCP servers.** The servers you've already set up in Codex and Claude Code are picked up automatically (remote ones need one sign-in inside baton). Type `/mcp` to add more from Codex and Claude Code, from popular ones (GitHub, Linear, Notion, Figma, Sentry, Playwright…), or by searching the official MCP registry; they connect immediately and remote ones sign in through your browser. Every model in the chain can use their tools, so switching providers never loses them. The same is available as `baton mcp …` commands.
- **Your project's rules, for every model.** baton reads `AGENTS.md` and `CLAUDE.md` (project, parent folders, and your global Codex / Claude Code ones, with `@imports`), so a provider switch never loses your conventions. `/init` writes one for a new repo.
- **Your skills, commands and hooks.** Skills from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` and the project's `.claude/skills` work with every model (loaded on demand) or run directly as `/name`. Custom commands from `.claude/commands` and `~/.codex/prompts` show up in the `/` menu with `$ARGUMENTS`, `$1` and `` !`shell` `` support. Hooks in Claude Code's format run around prompts and tools (a project's own hooks only after `/trust`).
- **Plan mode, undo and @files.** `shift+tab` into plan mode to have the model investigate and propose a plan before touching anything. Every request is snapshotted first, so `/undo` or `/rewind` puts files back (your own git history is never touched). Type `@` to attach files.
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
| `enter` while it's working | queue a follow-up; it's sent when the current step finishes |
| `1` `2` `3` or `↑↓` + `enter` | answer a permission prompt (yes · yes for this session · no); `esc` = no |
| `shift+tab` | cycle permission mode: ask · auto-approve edits · plan mode (shown in the footer) |
| `@` | pick a project file to attach (fuzzy search; `tab`/`enter` inserts) |
| `/` | menu of every command: built-ins, your custom commands, and skills (`tab` completes, `enter` runs) |
| `^O` | print the full output of the last step |
| `^P` | processes: `↑↓` select, live output, `k` stop, `c` clear finished, `esc` close |
| `esc` | interrupt the current step |
| `^C` | interrupt; press twice when idle to exit |
| `^D` | exit (asks first if processes are still running) |
| `!cmd` | run a shell command yourself; it shows up under processes |

With `--fullscreen`, the process pane sits on the right and is clickable (`^P` or click `⚙ N running`); hold `Option` to select text, or add `--no-mouse`.

| Command | |
|---|---|
| `/model` | pick any model on any account (every ChatGPT-plan model Codex offers, every Claude model), with each account's status and when a limited plan comes back; `/model claude-sonnet-5-5` switches directly. Your pick is saved as that account's default. |
| `/status` | session id, token usage and cost, switches so far, files modified |
| `/compact` | preview what compaction would do for the current model |
| `/mcp` | manage MCP servers without leaving the session: see status and tools, sign in, reconnect, disable or remove; add servers from Codex and Claude Code, from a list of popular ones (GitHub, Linear, Notion, Figma, Sentry…), or by searching the MCP registry. New servers connect immediately. |
| `/undo`, `/rewind` | put files back as they were before the last (or any earlier) request |
| `/init`, `/memory` | write an `AGENTS.md` for the project; list the instruction files every model follows |
| `/skills`, `/hooks`, `/trust` | list skills; list hooks and where they come from; let this project's own hooks run |
| `/clear` | clear the screen (the session keeps its history) |
| `/exit` | quit; the session is saved |

| CLI | |
|---|---|
| `baton doctor` | check keys, credits, model ids, tool calling and reasoning replay for every model in the chain |
| `baton init` | write a starter `~/.baton/config.json` |
| `baton mcp import` | list MCP servers from Codex and Claude Code; `baton mcp import playwright linear` or `--all` copies them in |
| `baton mcp add <name> -- <cmd>` / `--url <url>` | add a local or remote MCP server; `baton mcp list` checks them; `baton mcp login <name>` signs in |
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
