#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from './agent/loop.js';
import { type ApprovalMode, configPaths, loadConfig, starterConfig, toTargets } from './config/config.js';
import { runDoctor } from './doctor.js';
import { discoverServers, runMcpCommand } from './mcp/cli.js';
import { McpManager } from './mcp/client.js';
import { HookRunner, isTrusted, loadHookSources, transcriptPathFor } from './agent/hooks.js';
import { Session } from './ir/session.js';
import { MissingKeyAdapter, buildAdapters } from './providers/registry.js';
import { Router, targetLabel } from './router/router.js';
import { ProcessManager } from './tools/processes.js';
import { ToolEngine } from './tools/registry.js';
import { createRl, makeApprover, runRepl, terminalEvents } from './ui/repl.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const USAGE = `baton — coding agent that hot-swaps LLM providers mid-session

Usage:
  baton                      interactive session
  baton -p "prompt"          run one prompt non-interactively, then exit
  baton --continue           resume the most recent session
  baton --resume <id>        resume a specific session
  baton doctor               verify every model in the chain with a real tool call
  baton init                 write a starter ~/.baton/config.json
  baton mcp                  connect MCP servers (list, add, import, login)

Options:
  -m, --model <name>         start on this chain entry (label, model id, or index)
  -a, --approval <mode>      ask | auto-edit | plan | yolo   (default: ask)
  -y, --yes                  shorthand for --approval yolo
      --plain                simple line-based prompt
      --fullscreen           full-screen layout with a side process pane and mouse support
      --no-mouse             with --fullscreen: don't capture the mouse
  -v, --version              print the version
  -h, --help                 show this help

Config: ./baton.config.json, else ~/.baton/config.json, else built from
OPENAI_API_KEY / ANTHROPIC_API_KEY in the environment. Setup guide: docs/SETUP.md`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      print: { type: 'string', short: 'p' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      model: { type: 'string', short: 'm' },
      approval: { type: 'string', short: 'a' },
      yes: { type: 'boolean', short: 'y' },
      plain: { type: 'boolean' },
      fullscreen: { type: 'boolean' },
      'no-mouse': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.version) {
    console.log(VERSION);
    return 0;
  }

  const cwd = process.cwd();
  if (positionals[0] === 'mcp') return runMcpCommand(process.argv.slice(process.argv.indexOf('mcp') + 1), cwd);

  if (positionals[0] === 'init') {
    const target = configPaths(cwd)[1]!;
    if (existsSync(target)) {
      console.log(`${target} already exists; not overwriting. Run \`baton doctor\` to check it.`);
      return 0;
    }
    mkdirSync(dirname(target), { recursive: true });
    const cfg = starterConfig();
    writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`Wrote ${target}`);
    console.log(`Failover chain: ${cfg.chain.map((t) => `${t.provider}/${t.model}`).join(' → ')}`);
    console.log('Edit the order or models there if you like, then run: baton doctor');
    return 0;
  }

  const { config, source } = loadConfig(cwd);
  if (positionals[0] === 'doctor') return runDoctor(config, source);

  if (config.chain.length === 0) {
    console.error('No models configured. Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY, or create baton.config.json.\n');
    console.error(USAGE);
    return 1;
  }

  const adapters = buildAdapters(config);
  const missing = [...adapters.values()].filter((a): a is MissingKeyAdapter => a instanceof MissingKeyAdapter);
  if (missing.length === adapters.size) {
    console.error(`No API keys found (${missing.map((m) => m.envName).join(', ')}). See docs/SETUP.md, then run: baton doctor`);
    return 1;
  }
  for (const m of missing) console.error(`warning: ${m.envName} is not set; "${m.name}" will be skipped during failover.`);
  const router = new Router(toTargets(config), adapters);
  const firstWithKey = router.chain.findIndex((t) => !(adapters.get(t.provider) instanceof MissingKeyAdapter));
  router.setCurrent(String(firstWithKey));
  if (values.model) router.setCurrent(values.model);

  const resumeId = values.resume ?? (values.continue ? Session.latestId() : undefined);
  if (values.continue && !resumeId) console.error('No previous session found; starting a new one.');
  const session = resumeId ? Session.load(resumeId) : new Session(undefined, cwd);

  const approval = (values.yes ? 'yolo' : values.approval ?? config.approval ?? 'ask') as ApprovalMode;
  if (!['ask', 'auto-edit', 'plan', 'yolo'].includes(approval)) throw new Error(`Unknown approval mode "${approval}"`);

  const prompt = values.print ?? (positionals.length ? positionals.join(' ') : undefined);
  const oneShot = values.print !== undefined || !process.stdin.isTTY;
  const processes = new ProcessManager();
  process.once('exit', () => processes.killAll());
  // Every session gets MCP: baton's own servers plus the ones already set up in
  // Codex and Claude Code, discovered automatically so nothing is added twice.
  const mcp = new McpManager(config.mcpServers ?? {}, session.cwd);
  const loadMcp = async () => {
    for (const c of await discoverServers(session.cwd, config)) mcp.add(c.name, c.config, c.source === 'codex' ? 'codex' : 'claude');
    await mcp.connectAll();
  };
  const hooks = new HookRunner(session.cwd, session.id, transcriptPathFor(session.id), loadHookSources(session.cwd, config.hooks), isTrusted(session.cwd));
  const hookWarning = hooks.untrustedProjectHooks.length
    ? `This project defines hooks in ${hooks.untrustedProjectHooks.map((s) => s.label).join(', ')} (commands that run automatically). They're off until you run /trust here; /hooks shows them.`
    : undefined;
  const mcpSummary = () => {
    const s = mcp.servers;
    const ok = s.filter((x) => x.status === 'connected');
    const bad = s.filter((x) => x.status === 'failed' || x.status === 'needs-login');
    const tools = ok.reduce((n, x) => n + x.tools.length, 0);
    const fromOthers = s.filter((x) => x.origin !== 'baton').length;
    const login = bad.filter((b) => b.status === 'needs-login').map((b) => b.name);
    const failed = bad.filter((b) => b.status === 'failed').map((b) => b.name);
    return [
      `MCP: ${ok.length} of ${s.length} server${s.length === 1 ? '' : 's'} connected (${tools} tools)${fromOthers ? `, including ${fromOthers} found in Codex / Claude Code` : ''}.`,
      login.length ? ` Sign in once with /mcp: ${login.join(', ')}.` : '',
      failed.length ? ` Not starting: ${failed.join(', ')} (details in /mcp).` : '',
    ].join('');
  };

  if (oneShot) {
    if (!prompt) {
      console.error('Nothing to do: pass a prompt with -p.');
      return 1;
    }
    await loadMcp();
    hooks.on('notice', (m: string) => process.stderr.write(`${m}\n`));
    if (hookWarning) process.stderr.write(`${hookWarning}\n`);
    const agent = new Agent(session, router, new ToolEngine(), { cwd: session.cwd, processes, mcp, hooks, approve: makeApprover(approval, () => undefined), planMode: () => approval === 'plan' });
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    await agent.run(prompt, terminalEvents(), controller.signal).finally(() => agent.close());
    process.stdout.write('\n');
    process.stderr.write(`[${targetLabel(router.current)} · session ${session.id}]\n`);
    return 0;
  }

  if (prompt) console.error('Tip: use -p for one-shot mode. Starting interactive session.');

  const fullScreen = !values.plain && process.stdout.isTTY && (process.stdout.columns ?? 0) >= 60 && (process.stdout.rows ?? 0) >= 12;
  if (fullScreen) {
    const { TuiStore } = await import('./ui/tui/store.js');
    const { runTui } = await import('./ui/tui/run.js');
    const store = new TuiStore(session.cwd, approval);
    const agent = new Agent(session, router, new ToolEngine(), { cwd: session.cwd, processes, mcp, hooks, approve: store.approve, planMode: () => store.approvalMode === 'plan' });
    hooks.on('notice', (m: string) => store.push({ kind: 'notice', level: 'warn', text: m }));
    if (hookWarning) store.push({ kind: 'notice', level: 'warn', text: hookWarning });
    // Servers connect in the background; tools appear as each one is ready.
    // Servers connect in the background; tools appear as each one is ready.
    void loadMcp().then(() => {
      if (mcp.servers.length) store.push({ kind: 'notice', level: mcp.servers.some((s) => s.status === 'needs-login' || s.status === 'failed') ? 'warn' : 'info', text: mcpSummary() });
    });
    await runTui(agent, { store, version: VERSION, mouse: !values['no-mouse'], approval, layout: values.fullscreen ? 'fullscreen' : 'inline', configFile: existsSync(source) ? source : undefined });
    await agent.close();
    console.log(`Session saved. Resume with: baton --resume ${session.id}`);
    return 0;
  }

  const rl = createRl();
  await loadMcp();
  if (mcp.servers.length) console.log(mcpSummary());
  hooks.on('notice', (m: string) => console.error(m));
  if (hookWarning) console.error(hookWarning);
  const agent = new Agent(session, router, new ToolEngine(), { cwd: session.cwd, processes, mcp, hooks, approve: makeApprover(approval, () => rl), planMode: () => approval === 'plan' });
  await runRepl(agent, rl, source);
  rl.close();
  await agent.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`baton: ${err.message}`);
    process.exit(1);
  },
);
