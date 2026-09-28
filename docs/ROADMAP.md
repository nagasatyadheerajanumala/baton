# baton roadmap

baton's promise: **you never lose your place because of a model.** Every feature is judged against that, plus parity with the tools people already use (Claude Code, Codex CLI), so switching to baton never feels like a downgrade.

Competitor columns reflect their public docs as of September 2026. **Status:** `built` · `building` · `P0` (next, needed for daily use) · `P1` (soon) · `P2` (later).

## 1. Parity: what Claude Code and Codex CLI do

### Agent core and models

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Agent loop with streaming | yes | yes | built |
| Multiple models, `/model` picker | Claude only | OpenAI only (+ local OSS) | built, any provider |
| Use your Claude / ChatGPT subscription | yes (own plan) | yes (own plan) | built: both, in one chain, via the official CLIs |
| Reasoning effort control (low to max) | yes | yes | P0 (config done for OpenAI; per-turn toggle + Anthropic effort) |
| "Think harder" keyword / per-turn effort | yes (ultrathink) | yes | P1 |
| Auto-compaction when context fills | yes | yes | built (deterministic); P1 LLM summary pass |
| `/compact` manual compaction | yes | yes | built (preview); P0 apply with optional focus prompt |
| `/context` view of what fills the window | yes | partial | P1 |
| Prompt caching | yes | yes | built (Anthropic breakpoints; OpenAI automatic) |

### Interface

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Terminal UI (scrollback transcript, permission prompts, model picker, modes) | yes | yes | built (plus --fullscreen split layout) |
| Background processes view (`/bashes`, tasks) | yes | partial | built (process pane with live output, click to inspect, stop) |
| Inline diffs for edits | yes | yes | built |
| Esc / Ctrl-C interrupt | yes | yes | built |
| Queue a message while the agent works | yes | yes | built |
| Multi-line input, paste handling | yes | yes | P0 |
| Open `$EDITOR` for long prompts | yes | yes | P1 |
| Transcript view (full tool I/O) | yes (ctrl-o) | yes (ctrl-t) | partial: output previews + ctrl-o full output |
| Vim keybindings | yes | no | P2 |
| Custom status line | yes | partial | P2 |
| Themes / light terminal support | yes | yes | P1 |
| Desktop notification when done / needs approval | yes | yes | P1 |
| Shell completion | yes | yes | P2 |

### Input and context

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| `@file` mentions with fuzzy picker | yes | yes | built |
| Image input (paste screenshot, `--image`) | yes | yes | P1 |
| Project memory file (CLAUDE.md / AGENTS.md) | CLAUDE.md | AGENTS.md | built: reads both, nested and user-level, with @imports |
| `/init` to generate the memory file | yes | yes | built |
| `#` quick-add to memory | yes | no | P2 |
| `!` run a shell command directly | yes | yes | built |
| `--add-dir` extra working directories | yes | yes | P1 |
| Web search and fetch tools | yes | yes (`--search`) | P1 |

### Safety

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Approval prompts for edits and commands | yes | yes | built |
| Approval modes (ask / auto-edit / full) | yes | yes | built |
| Allow/deny rules per tool and pattern (`Bash(npm test*)`) | yes | partial | partial: read-only commands auto-allowed, session-wide allow; P0 per-pattern rules |
| Plan mode (read-only until approved) | yes | partial | built (enforced for every provider) |
| OS sandbox for commands (Seatbelt / Landlock), network off by default | yes | yes | P1 |
| Workspace trust prompt for new folders | yes | yes | P1 |
| Checkpoints and `/rewind` / undo | yes | yes | built (per-request snapshots, undoable rewinds) |
| Auto mode (classifier approves safe actions) | yes | no | P2 |

### Sessions

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Resume (`--continue`, `--resume`, picker) | yes | yes | built (flags); P0 interactive picker |
| Export transcript | yes | partial | P1 |
| Session saved as you go (crash-safe) | yes | yes | built (append-only log) |

### Tools

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Read / write / exact-string edit | yes | yes (apply_patch) | built |
| Multi-edit / patch tool for large changes | yes | yes | P1 (`apply_patch`, which OpenAI models are trained on) |
| Search (ripgrep) and file listing | yes | yes | built |
| Shell with timeout | yes | yes | built |
| Background shell + read output + kill | yes | partial | built |
| Todo / plan tracking tool | yes | yes | P0 |
| LSP diagnostics after edits | partial | no | P2 |

### Extensibility

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| MCP client (stdio + HTTP servers) | yes | yes | built: stdio/http/sse, OAuth sign-in, import from Codex and Claude Code, tools shared by every model |
| Custom slash commands / prompts | yes | yes | P1 (reads `.claude/commands` and Codex prompts too) |
| Skills | yes | yes | P1 (same `SKILL.md` format, so existing skills work) |
| Hooks (before/after tool, on stop, on prompt) | yes | partial (notify) | P1 |
| Subagents (isolated context, parallel work) | yes | partial | P2 |
| Plugins / marketplace | yes | yes | P2 |

### Automation and integrations

| Feature | Claude Code | Codex CLI | baton |
|---|---|---|---|
| Headless mode (`-p`, `exec`) | yes | yes | built |
| JSON / stream-JSON output | yes | yes | P0 |
| `/review` of uncommitted changes or a branch | yes | yes | P1 (can use a different model; see section 2) |
| SDK for building on top | yes | yes | P2 (core is already a library) |
| GitHub Action / PR review bot | yes | yes | P2 |
| IDE extension (diffs in editor) | yes | yes | P2 |
| Git worktrees for parallel sessions | yes | partial | P1 |
| Cloud / remote execution | yes | yes | not planned (local-first) |
| Telemetry export (OpenTelemetry) | yes | partial | P2 |

## 2. Beyond parity: what only a multi-provider harness can do

These are baton's reason to exist. Ordered by value.

1. **Proactive switching before you hit the wall.** Both providers send rate-limit headroom headers on every response (`anthropic-ratelimit-*-remaining`, `x-ratelimit-remaining-tokens`). baton can see a limit coming and hand off at the next clean turn boundary, instead of failing mid-task. `P0`
2. **Headroom meter in the status bar.** Remaining requests/tokens per provider and time until reset, so you know before it matters. `P0`
3. **Import sessions from Claude Code and Codex.** Resume a stuck Claude Code or Codex session inside baton, with history, tool calls and file context. This was the original pain point. `P1`
4. **Cross-model review.** `/review` sends your diff to a *different* provider than the one that wrote it. A second model catches different mistakes. `P1`
5. **Budgets and cost-aware routing.** Per-session and per-day spend caps (`--budget 5`), and warnings before an expensive switch (for example, moving a 600k-token context onto a pricier model). `P1`
6. **Task-based routing.** Route cheap work (search, summaries, compaction) to a fast, cheap model and planning or hard edits to a strong one, automatically. `P1`
7. **Race / best-of-N.** Send the same task to two providers in separate worktrees and compare the diffs side by side. `P2`
8. **Consensus for risky actions.** Before a destructive command or a large rewrite, ask a second model whether it's safe. `P2`
9. **Per-model prompt tuning.** Each model family gets the system prompt and tool descriptions it responds to best (for example, `apply_patch` for OpenAI, exact-string edits for Claude). `P1`
10. **Offline fallback.** A local model (Ollama) at the end of the chain keeps you moving when you're offline or every paid provider is out. `built` (improve tool reliability for small models: P2)
11. **Provider-neutral memory.** One project memory that every model reads (AGENTS.md and CLAUDE.md merged), so switching doesn't lose conventions. `P0`
12. **Portable session format.** Documented, versioned JSONL, so sessions can be replayed, diffed, shared, or turned into regression tests for prompts. `P2`
13. **Dev-server awareness.** The process pane detects URLs and ports in output (`http://localhost:5173`), makes them clickable, and warns when a port is already taken. `P1`
14. **Unified spend dashboard.** `baton usage`: spend and tokens per provider, per project, per day. `P2`

## 3. Build order

**Now: make it a daily driver (P0)**
1. ~~Full-screen TUI with process pane, diffs, approvals~~ (done)
2. Transcript view, queued messages, multi-line input, `!` shell, `@file` picker
3. Memory files: AGENTS.md + CLAUDE.md, nested and user-level
4. Permission rules and plan mode
5. Checkpoints and `/rewind`
6. Todo tool
7. Proactive switching from rate-limit headers, and the headroom meter
8. JSON / stream-JSON output for scripting
9. Interactive session picker for `--resume`

**Next: parity plus the differentiators (P1)**
MCP client, custom commands and skills (compatible with existing `.claude/` files), hooks, web search/fetch, images, `apply_patch`, sandboxing, workspace trust, worktrees, `/review` on a different model, budgets, task routing, per-model prompts, import from Claude Code/Codex, LLM compaction pass, notifications, themes.

**Later (P2)**
Subagents, plugins, race mode, consensus checks, SDK, GitHub Action, IDE extension, telemetry, usage dashboard, vim mode, custom status line.

## Deliberately not doing (for now)

- **Cloud execution.** baton is local-first; your code and processes stay on your machine.
