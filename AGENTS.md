# baton

Coding-agent harness that hot-swaps LLM providers mid-session (e.g. OpenAI → Claude on quota exhaustion) while keeping conversation, tool state, and file changes intact.

## Commands

- `npm test` runs the vitest suite (unit, scripted e2e, and real-SDK wire tests against a local fake server; no API keys needed)
- `npm run typecheck`
- `npm run build` compiles to `dist/`; `npm run dev -- -p "prompt"` runs from source
- If vitest fails with "Cannot find native binding", or `package-lock.json` suddenly loses hundreds of lines, run `git checkout package-lock.json && npm ci`. npm drops platform-specific optional packages on `npm link` / `npm install <pkg>` (npm/cli#4828); don't commit that lockfile change.

## Architecture

```
src/
  ir/          types.ts: the IR (vendor-neutral messages); session.ts: JSONL log, settle(), derived views
  providers/   one adapter per wire protocol; ONLY place vendor formats exist
    anthropic.ts         Messages API (streaming, prompt caching, thinking replay)
    openai-responses.ts  Responses API for api.openai.com (stateless, encrypted reasoning replay)
    openai.ts            Chat Completions for OpenAI-compatible servers (OpenRouter, LiteLLM, Ollama)
    registry.ts          config -> adapters; MissingKeyAdapter for providers without a key
    cli/                 subscription providers: drive the official CLIs (external agents)
      claude-code.ts       `claude -p --output-format stream-json --tools "" --mcp-config ...`
      codex.ts             `codex exec --json --sandbox read-only -c mcp_servers.baton...`
      transcript.ts        IR -> text transcript for handoffs into a CLI
      common.ts            JSONL runner, CLI error -> router error, per-session seen-tracking
  mcp/bridge.ts  Streamable HTTP MCP server (127.0.0.1 + secret path) exposing the ToolEngine to CLIs;
                 records every CLI step into the session
  router/      errors.ts: SDK error -> FailureKind; router.ts: retry / compact / failover policy
  compaction/  deterministic, produces a *view*; never rewrites the session log
  tools/       vendor-agnostic tool engine (fs, search, bash, process_*, git_status) + approval gate
    processes.ts   ProcessManager: every shell command tools start; bounded output; group kill
    readonly.ts    conservative read-only shell detection (auto-approved: git status/log/diff, ls, rg...)
  agent/       loop.ts: model -> tools -> model; handoff note on provider switch (incl. running processes)
  pricing.ts   list prices + session cost estimate
  ui/
    commands.ts    slash commands shared by both UIs
    repl.ts        line-based prompt (--plain, pipes, narrow terminals)
    theme.ts       palette + glyphs; all UI color goes through here
    tui/           Ink apps
      InlineApp.tsx  default: finished steps printed to scrollback (<Static>), live bottom area only
      App.tsx        --fullscreen: alt screen, side process pane, mouse
      store.ts     UI state driven by agent events (no React): queue, picker, approval, printed index
      format.ts    pure renderers: transcript entries (shared), process pane, fullscreen chrome
      panels.ts    inline widgets: permission prompt, model picker, process box, input box, footer
      editor.ts    readline-style prompt editing (pure)
      mouse.ts     SGR mouse parsing; strips reports from stdin before Ink sees them
      run.tsx      picks the layout; mouse on/off and cleanup for fullscreen
  config/      baton.config.json > ~/.baton/config.json > env-derived chain; DEFAULT_MODELS
    models.ts    per-account model catalog (/model picker): Codex plan models from ~/.codex/models_cache.json, Claude lineup, OpenAI API lineup
  doctor.ts    `baton doctor`: real two-step tool loop per chain entry, plain-language diagnosis
```

## Invariants (don't break these)

1. **Only complete assistant turns are committed.** A stream that dies mid-response is discarded, so every provider switch happens on a settled boundary.
2. **Every `tool_call` gets exactly one `tool_result` in the next user message.** Even on abort/deny/crash; `settleMessages()` repairs logs, `repairPairing()` runs after compaction. Both Anthropic and OpenAI reject histories that violate this.
3. **Adapters throw raw SDK errors.** Classification lives in `router/errors.ts`; SDK `maxRetries` is 0 so the router owns all retry policy.
4. **Tool ids are kept verbatim in the IR** and sanitized deterministically on the way out (`sanitizeToolId`), so call/result pairs always agree.
5. **`fatal` errors are never masked by failover.** A malformed request would fail on every provider; surface it.
6. **The router is sticky.** After failover it stays on the new target; switching back is explicit (`/model`).
7. **Reasoning blocks are model-bound.** `reasoning` IR blocks carry `origin = protocol:model`; only the adapter calling that exact model emits them, verbatim and in original order. Anthropic and OpenAI both require them within a tool loop (Anthropic silently disables thinking otherwise).
8. **A missing API key never crashes startup.** It becomes a `MissingKeyAdapter` that fails as `auth`, so failover skips it.
9. **Nothing baton starts outlives it.** Processes run in their own process group and `killAll()` runs on every exit path.
10. **Renderers return exact-width lines.** `format.ts` functions pad/truncate to the column; mouse hit-testing relies on the layout they report (`procCols`, `rowIds`, `closeCols`).
11. **Subscriptions only through the official, unmodified CLIs.** baton never reads, stores or proxies Claude/ChatGPT login tokens (Anthropic's terms forbid it for Claude). Status checks ask the CLI (`claude auth status`, `codex login status`); never open their credential files.
12. **External agents execute tools only through the bridge.** Claude Code runs with `--tools ""`; Codex runs read-only with baton's MCP server pre-approved. That keeps approvals, the process pane and the IR log authoritative.
13. **Permission prompts answer only to numbers, arrows+enter and esc.** Never letters: text typed mid-sentence as a prompt appears must not approve anything. Read-only detection (readonly.ts) must stay conservative; when unsure, ask.

## Design decisions

- TypeScript/Node, official SDKs, minimal deps (no CLI framework; `node:util` parseArgs). Full-screen UI on Ink 7 (React for terminals), one accent color on a muted palette (theme.ts).
- OpenAI itself goes through the Responses API: current OpenAI reasoning models only allow function calling on Chat Completions with reasoning off. Chat Completions remains the adapter for OpenAI-compatible servers.
- Default model ids live in `DEFAULT_MODELS` (src/config/config.ts), checked against provider docs 2026-09-28.
- Compaction is deterministic for now (stale reads → head/tail truncation → drop middle turns with a state summary). LLM summarization can slot in as a pass between truncation and drop, and must not run on the failover path itself.
- Subscriptions run through the official CLIs rather than direct OAuth: permitted for Claude (unmodified Claude Code, user's own login), and for OpenAI it avoids depending on the undocumented ChatGPT Codex endpoint. Trade-off: handoffs *into* a CLI pass history as a transcript.
