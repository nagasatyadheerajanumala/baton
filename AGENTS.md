# baton

Coding-agent harness that hot-swaps LLM providers mid-session (e.g. OpenAI → Claude on quota exhaustion) while keeping conversation, tool state, and file changes intact.

## Commands

- `npm test` runs the vitest suite (unit, scripted e2e, and real-SDK wire tests against a local fake server; no API keys needed)
- `npm run typecheck`
- `npm run build` compiles to `dist/`; `npm run dev -- -p "prompt"` runs from source

## Architecture

```
src/
  ir/          types.ts: the IR (vendor-neutral messages); session.ts: JSONL log, settle(), derived views
  providers/   one adapter per wire protocol; ONLY place vendor formats exist
    anthropic.ts         Messages API (streaming, prompt caching, thinking replay)
    openai-responses.ts  Responses API for api.openai.com (stateless, encrypted reasoning replay)
    openai.ts            Chat Completions for OpenAI-compatible servers (OpenRouter, LiteLLM, Ollama)
    registry.ts          config -> adapters; MissingKeyAdapter for providers without a key
  router/      errors.ts: SDK error -> FailureKind; router.ts: retry / compact / failover policy
  compaction/  deterministic, produces a *view*; never rewrites the session log
  tools/       vendor-agnostic tool engine (fs, search, bash, process_*, git_status) + approval gate
    processes.ts   ProcessManager: every shell command tools start; bounded output; group kill
  agent/       loop.ts: model -> tools -> model; handoff note on provider switch (incl. running processes)
  pricing.ts   list prices + session cost estimate
  ui/
    commands.ts    slash commands shared by both UIs
    repl.ts        line-based prompt (--plain, pipes, narrow terminals)
    theme.ts       palette + glyphs; all UI color goes through here
    tui/           full-screen Ink app
      store.ts     UI state driven by agent events (no React)
      format.ts    pure renderers: conversation, process pane, header, status, input
      editor.ts    readline-style prompt editing (pure)
      mouse.ts     SGR mouse parsing; strips reports from stdin before Ink sees them
      App.tsx      layout, keyboard and mouse handling
      run.tsx      alt screen, mouse on/off, cleanup
  config/      baton.config.json > ~/.baton/config.json > env-derived chain; DEFAULT_MODELS
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

## Design decisions

- TypeScript/Node, official SDKs, minimal deps (no CLI framework; `node:util` parseArgs). Full-screen UI on Ink 7 (React for terminals), one accent color on a muted palette (theme.ts).
- OpenAI itself goes through the Responses API: current OpenAI reasoning models only allow function calling on Chat Completions with reasoning off. Chat Completions remains the adapter for OpenAI-compatible servers.
- Default model ids live in `DEFAULT_MODELS` (src/config/config.ts), checked against provider docs 2026-09-28.
- Compaction is deterministic for now (stale reads → head/tail truncation → drop middle turns with a state summary). LLM summarization can slot in as a pass between truncation and drop, and must not run on the failover path itself.
- Subscription/OAuth auth (reusing Claude/ChatGPT plan logins) is **deliberately not implemented**; check provider terms before adding it. It would be an auth option on an existing adapter, not a new adapter.
