import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Config, configPaths, starterConfig } from '../config/config.js';
import { FileOAuthProvider, type McpServerConfig, McpManager, loginToServer, mcpAuthDir, transportKind } from './client.js';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const USAGE = `baton mcp — connect MCP servers; their tools work with every model in your chain

  baton mcp list                          servers and their status (connects to each)
  baton mcp add <name> -- <command> [args...]    add a local (stdio) server
  baton mcp add <name> --url <url> [--header "K: V"] [--bearer-env VAR]   add a remote server
  baton mcp remove <name>
  baton mcp import                        show servers configured in Codex and Claude Code
  baton mcp import <name...> | --all      copy them into baton
  baton mcp login <name>                  sign in to a remote server (opens your browser)`;

/** Which file `baton mcp` edits: the config baton loads, or a new ~/.baton/config.json. */
export function editableConfig(cwd: string): { path: string; config: Config } {
  for (const p of configPaths(cwd)) if (existsSync(p)) return { path: p, config: JSON.parse(readFileSync(p, 'utf8')) as Config };
  const path = configPaths(cwd)[1]!;
  return { path, config: starterConfig() };
}

function save(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

// ---- Import sources ----------------------------------------------------------------

export interface ImportCandidate {
  name: string;
  source: 'codex' | 'claude' | 'project';
  config: McpServerConfig;
  /** Helper that ships inside another app and likely won't run outside it. */
  builtIn: boolean;
}

const CODEX_BUILTINS = new Set(['codex_app', 'node_repl', 'computer-use', 'cua_repl', 'open_browser_use']);

interface CodexListItem {
  name: string;
  enabled?: boolean;
  transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string>; env_vars?: string[]; cwd?: string; url?: string; bearer_token_env_var?: string; http_headers?: Record<string, string> };
}

/** Servers from Codex, via `codex mcp list --json` (asks the CLI; no credential files). */
export function codexCandidates(): ImportCandidate[] {
  const r = spawnSync('codex', ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return [];
  let items: CodexListItem[] = [];
  try {
    items = JSON.parse(r.stdout) as CodexListItem[];
  } catch {
    return [];
  }
  return items.map((i) => {
    const t = i.transport ?? {};
    const config: McpServerConfig =
      t.type === 'stdio'
        ? { command: t.command, args: t.args ?? [], ...(t.env && Object.keys(t.env).length ? { env: t.env } : {}), ...(t.env_vars?.length ? { envVars: t.env_vars } : {}), ...(t.cwd ? { cwd: t.cwd } : {}) }
        : { type: 'http', url: t.url, ...(t.http_headers ? { headers: t.http_headers } : {}), ...(t.bearer_token_env_var ? { bearerTokenEnv: t.bearer_token_env_var } : {}) };
    if (i.enabled === false) config.enabled = false;
    const builtIn = CODEX_BUILTINS.has(i.name) || (t.command ?? '').includes('/.codex/');
    return { name: i.name, source: 'codex' as const, config, builtIn };
  });
}

interface ClaudeServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function fromClaude(s: ClaudeServer): McpServerConfig {
  if (s.url) return { type: s.type === 'sse' ? 'sse' : 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
  return { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
}

/** Servers from Claude Code's user config (~/.claude.json: only the mcpServers entries) and the project's .mcp.json. */
export function claudeCandidates(cwd: string): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { mcpServers?: Record<string, ClaudeServer>; projects?: Record<string, { mcpServers?: Record<string, ClaudeServer> }> };
    for (const [name, s] of Object.entries({ ...d.mcpServers, ...d.projects?.[cwd]?.mcpServers })) out.push({ name, source: 'claude', config: fromClaude(s), builtIn: false });
  } catch {
    /* no Claude Code config */
  }
  try {
    const p = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, ClaudeServer> };
    for (const [name, s] of Object.entries(p.mcpServers ?? {})) out.push({ name, source: 'project', config: fromClaude(s), builtIn: false });
  } catch {
    /* no project .mcp.json */
  }
  return out;
}

// ---- Commands ------------------------------------------------------------------------

function describeServer(c: McpServerConfig): string {
  return transportKind(c) === 'stdio' ? `${c.command ?? '?'} ${(c.args ?? []).join(' ')}`.trim() : `${c.url ?? '?'}`;
}

function statusLine(state: { status: string; error?: string; tools: unknown[] }): string {
  switch (state.status) {
    case 'connected':
      return green(`connected · ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'}`);
    case 'needs-login':
      return yellow(`needs sign-in · ${state.error ?? ''}`);
    case 'disabled':
      return dim('disabled');
    default:
      return red(`failed · ${state.error ?? ''}`);
  }
}

export async function runMcpCommand(args: string[], cwd: string, log: (s: string) => void = (s) => process.stdout.write(s + '\n')): Promise<number> {
  const [sub, ...rest] = args;
  const { path, config } = editableConfig(cwd);
  const servers = (config.mcpServers ??= {});

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      log(USAGE);
      return 0;

    case 'list': {
      const names = Object.keys(servers);
      if (!names.length) {
        log(`No MCP servers yet. Add one with ${dim('baton mcp add')} or bring yours over with ${dim('baton mcp import')}.`);
        return 0;
      }
      log(dim(`config: ${path}\n`));
      const manager = new McpManager(servers, cwd);
      await manager.connectAll(15_000);
      for (const s of manager.servers) {
        log(`${s.status === 'connected' ? green('●') : s.status === 'disabled' ? dim('○') : yellow('●')} ${s.name}  ${dim(describeServer(s.config))}`);
        log(`    ${statusLine(s)}`);
      }
      await manager.close();
      return 0;
    }

    case 'add': {
      const name = rest[0];
      if (!name) {
        log(USAGE);
        return 1;
      }
      const dash = rest.indexOf('--');
      let entry: McpServerConfig;
      if (dash >= 0) {
        const [command, ...cmdArgs] = rest.slice(dash + 1);
        if (!command) return log('Give the command after --, e.g. baton mcp add playwright -- npx @playwright/mcp@latest'), 1;
        entry = { command, args: cmdArgs };
      } else {
        const url = rest[rest.indexOf('--url') + 1];
        if (!rest.includes('--url') || !url) return log('Give --url <url> for a remote server, or -- <command> for a local one.'), 1;
        entry = { type: rest.includes('--sse') ? 'sse' : 'http', url };
        const headers: Record<string, string> = {};
        rest.forEach((a, i) => {
          if (a === '--header' && rest[i + 1]) {
            const [k, ...v] = rest[i + 1]!.split(':');
            headers[k!.trim()] = v.join(':').trim();
          }
        });
        if (Object.keys(headers).length) entry.headers = headers;
        const bearer = rest[rest.indexOf('--bearer-env') + 1];
        if (rest.includes('--bearer-env') && bearer) entry.bearerTokenEnv = bearer;
      }
      servers[name] = entry;
      save(path, config);
      log(`Added ${name} to ${path}.`);
      const manager = new McpManager({ [name]: entry }, cwd);
      const state = await manager.connect(name, 15_000);
      await manager.close();
      log(`  ${statusLine(state)}`);
      return 0;
    }

    case 'remove': {
      const name = rest[0];
      if (!name || !servers[name]) return log(`No MCP server "${name ?? ''}".`), 1;
      delete servers[name];
      save(path, config);
      log(`Removed ${name}.`);
      return 0;
    }

    case 'import': {
      const candidates = [...codexCandidates(), ...claudeCandidates(cwd)];
      if (!rest.length) {
        if (!candidates.length) return log('Found no MCP servers in Codex or Claude Code.'), 0;
        log('MCP servers found in your other tools:\n');
        for (const c of candidates) {
          const have = servers[c.name] ? green(' (already in baton)') : '';
          const note = c.builtIn ? dim(' (built into Codex; may not run outside it)') : '';
          log(`  ${c.name.padEnd(18)} ${dim(c.source.padEnd(8))} ${dim(describeServer(c.config))}${have}${note}`);
        }
        log(`\nImport with: baton mcp import <name...>   or   baton mcp import --all`);
        return 0;
      }
      const wanted = rest.includes('--all') ? candidates.filter((c) => !c.builtIn).map((c) => c.name) : rest;
      let added = 0;
      for (const name of wanted) {
        const c = candidates.find((x) => x.name === name);
        if (!c) {
          log(red(`  ${name}: not found in Codex or Claude Code`));
          continue;
        }
        servers[name] = c.config;
        added++;
        log(`  ${green('+')} ${name} ${dim(`from ${c.source}`)}`);
      }
      if (added) {
        save(path, config);
        log(`\nSaved to ${path}. Run ${dim('baton mcp list')} to check they connect.`);
        const remote = wanted.filter((n) => servers[n] && transportKind(servers[n]!) !== 'stdio');
        if (remote.length) log(`Remote servers may need sign-in: ${remote.map((n) => `baton mcp login ${n}`).join(' · ')}`);
      }
      return added ? 0 : 1;
    }

    case 'login': {
      const name = rest[0];
      const entry = name ? servers[name] : undefined;
      if (!name || !entry) return log(`No MCP server "${name ?? ''}". See baton mcp list.`), 1;
      try {
        return (await loginToServer(name, entry, cwd, log)) ? 0 : 1;
      } catch (err) {
        log(red(`Sign-in failed: ${(err as Error).message}`));
        return 1;
      }
    }

    case 'logout': {
      const name = rest[0];
      if (!name) return log('baton mcp logout <name>'), 1;
      const p = new FileOAuthProvider(name, undefined, mcpAuthDir());
      p.resetClient();
      p.saveTokens(undefined as never);
      log(`Signed out of ${name}.`);
      return 0;
    }

    default:
      log(`Unknown command "baton mcp ${sub}".\n\n${USAGE}`);
      return 1;
  }
}
