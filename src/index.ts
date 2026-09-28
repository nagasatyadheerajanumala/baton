#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Agent } from './agent/loop.js';
import { type ApprovalMode, configPaths, loadConfig, starterConfig, toTargets } from './config/config.js';
import { runDoctor } from './doctor.js';
import { Session } from './ir/session.js';
import { MissingKeyAdapter, buildAdapters } from './providers/registry.js';
import { Router, targetLabel } from './router/router.js';
import { ToolEngine } from './tools/registry.js';
import { createRl, makeApprover, runRepl, terminalEvents } from './ui/repl.js';

const USAGE = `baton — coding agent that hot-swaps LLM providers mid-session

Usage:
  baton                      interactive session
  baton -p "prompt"          run one prompt non-interactively, then exit
  baton --continue           resume the most recent session
  baton --resume <id>        resume a specific session
  baton doctor               verify every model in the chain with a real tool call
  baton init                 write a starter ~/.baton/config.json

Options:
  -m, --model <name>         start on this chain entry (label, model id, or index)
  -a, --approval <mode>      ask | auto-edit | yolo   (default: ask)
  -y, --yes                  shorthand for --approval yolo
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const cwd = process.cwd();

  if (positionals[0] === 'init') {
    const target = configPaths(cwd)[1]!;
    if (existsSync(target)) {
      console.log(`${target} already exists; not overwriting. Run \`baton doctor\` to check it.`);
      return 0;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(starterConfig(), null, 2) + '\n');
    console.log(`Wrote ${target}\nEdit the chain order/models if you like, export your API keys, then run: baton doctor`);
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
  if (!['ask', 'auto-edit', 'yolo'].includes(approval)) throw new Error(`Unknown approval mode "${approval}"`);

  const prompt = values.print ?? (positionals.length ? positionals.join(' ') : undefined);
  const oneShot = values.print !== undefined || !process.stdin.isTTY;
  const rl = oneShot ? undefined : createRl();
  const agent = new Agent(session, router, new ToolEngine(), {
    cwd: session.cwd,
    approve: makeApprover(approval, () => rl),
  });

  if (oneShot) {
    if (!prompt) {
      console.error('Nothing to do: pass a prompt with -p.');
      return 1;
    }
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    await agent.run(prompt, terminalEvents(), controller.signal);
    process.stdout.write('\n');
    process.stderr.write(`[${targetLabel(router.current)} · session ${session.id}]\n`);
    return 0;
  }

  if (prompt) console.error('Tip: use -p for one-shot mode. Starting interactive session.');
  await runRepl(agent, rl!, source);
  rl!.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`baton: ${err.message}`);
    process.exit(1);
  },
);
