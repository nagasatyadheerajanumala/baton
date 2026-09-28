import type { McpServerConfig } from './client.js';

/** Something the /mcp panel can offer to add. */
export interface CatalogEntry {
  /** Name it will get in your config. */
  name: string;
  description: string;
  config: McpServerConfig;
  /** Where it came from, shown next to it. */
  origin: 'popular' | 'codex' | 'claude' | 'project' | 'registry';
  /** Environment variables the server needs before it can start. */
  needsEnv?: string[];
  /** Ships inside another app and probably won't run outside it. */
  builtIn?: boolean;
  /** Registry id, e.g. "com.notion/mcp". */
  registryName?: string;
}

/**
 * Well-known servers, taken from their official entries in the MCP registry
 * (registry.modelcontextprotocol.io, checked 2026-09-28). Remote ones sign in
 * through the browser on first use.
 */
export const POPULAR: CatalogEntry[] = [
  { name: 'github', description: 'Repos, issues, pull requests, code search', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, origin: 'popular', registryName: 'io.github.github/github-mcp-server' },
  { name: 'linear', description: 'Issues, projects and cycles', config: { type: 'http', url: 'https://mcp.linear.app/mcp' }, origin: 'popular', registryName: 'app.linear/linear' },
  { name: 'notion', description: 'Pages, databases and search', config: { type: 'http', url: 'https://mcp.notion.com/mcp' }, origin: 'popular', registryName: 'com.notion/mcp' },
  { name: 'figma', description: 'Design files, components and variables', config: { type: 'http', url: 'https://mcp.figma.com/mcp' }, origin: 'popular', registryName: 'com.figma.mcp/mcp' },
  { name: 'sentry', description: 'Errors, issues and releases', config: { type: 'http', url: 'https://mcp.sentry.dev/mcp' }, origin: 'popular', registryName: 'io.github.getsentry/sentry-mcp' },
  { name: 'atlassian', description: 'Jira and Confluence', config: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' }, origin: 'popular', registryName: 'com.atlassian/atlassian-mcp-server' },
  { name: 'supabase', description: 'Databases, auth and edge functions', config: { type: 'http', url: 'https://mcp.supabase.com/mcp' }, origin: 'popular', registryName: 'com.supabase/mcp' },
  { name: 'vercel', description: 'Deployments, projects and logs', config: { type: 'http', url: 'https://mcp.vercel.com' }, origin: 'popular', registryName: 'com.vercel/vercel-mcp' },
  { name: 'stripe', description: 'Payments, customers and docs', config: { type: 'http', url: 'https://mcp.stripe.com' }, origin: 'popular', registryName: 'com.stripe/mcp' },
  { name: 'context7', description: 'Up-to-date library documentation', config: { type: 'http', url: 'https://mcp.context7.com/mcp' }, origin: 'popular', registryName: 'io.github.upstash/context7' },
  { name: 'cloudflare-docs', description: 'Cloudflare developer docs', config: { type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' }, origin: 'popular', registryName: 'com.cloudflare.mcp/mcp' },
  { name: 'huggingface', description: 'Models, datasets and Spaces', config: { type: 'http', url: 'https://huggingface.co/mcp?login' }, origin: 'popular', registryName: 'co.huggingface/hf-mcp-server' },
  { name: 'playwright', description: 'Drive a real browser', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, origin: 'popular', registryName: 'io.github.microsoft/playwright-mcp' },
  { name: 'chrome-devtools', description: 'Inspect and debug Chrome', config: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }, origin: 'popular', registryName: 'io.github.ChromeDevTools/chrome-devtools-mcp' },
];

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

interface RegistryServer {
  name?: string;
  description?: string;
  remotes?: { type?: string; url?: string; headers?: { name?: string; isRequired?: boolean }[] }[];
  packages?: {
    registryType?: string;
    identifier?: string;
    version?: string;
    runtimeHint?: string;
    transport?: { type?: string };
    environmentVariables?: { name?: string; isRequired?: boolean }[];
  }[];
}

/** Short config name from a registry id: "com.notion/mcp" -> "notion", "io.github.getsentry/sentry-mcp" -> "sentry-mcp". */
export function shortName(registryName: string): string {
  const [ns = '', last = ''] = registryName.split('/');
  const generic = /^(mcp|server|mcp-server)$/i.test(last);
  const base = generic ? ns.split('.').filter((p) => !['com', 'io', 'github', 'app', 'ai', 'co', 'org', 'dev', 'mcp'].includes(p)).pop() ?? last : last;
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'server';
}

/** Turn a registry entry into something baton can run, preferring a remote endpoint (no install). */
export function fromRegistry(s: RegistryServer): CatalogEntry | undefined {
  if (!s.name) return undefined;
  const base = { name: shortName(s.name), description: (s.description ?? '').trim(), origin: 'registry' as const, registryName: s.name };
  const remote = (s.remotes ?? []).find((r) => r.type === 'streamable-http' && r.url) ?? (s.remotes ?? []).find((r) => r.url);
  if (remote?.url && !remote.url.includes('{')) {
    const needsEnv = (remote.headers ?? []).filter((h) => h.isRequired && h.name).map((h) => h.name!);
    return { ...base, config: { type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url }, ...(needsEnv.length ? { needsEnv } : {}) };
  }
  const pkg = (s.packages ?? []).find((p) => (p.transport?.type ?? 'stdio') === 'stdio' && p.identifier);
  if (!pkg?.identifier) return undefined;
  const envVars = (pkg.environmentVariables ?? []).filter((e) => e.name).map((e) => e.name!);
  const needsEnv = (pkg.environmentVariables ?? []).filter((e) => e.isRequired && e.name).map((e) => e.name!);
  let config: McpServerConfig | undefined;
  if (pkg.registryType === 'npm') config = { command: 'npx', args: ['-y', pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier] };
  else if (pkg.registryType === 'pypi') config = { command: 'uvx', args: [pkg.identifier] };
  else if (pkg.registryType === 'oci') config = { command: 'docker', args: ['run', '-i', '--rm', ...envVars.flatMap((e) => ['-e', e]), pkg.identifier] };
  if (!config) return undefined;
  if (envVars.length) config.envVars = envVars;
  return { ...base, config, ...(needsEnv.length ? { needsEnv } : {}) };
}

/**
 * Search the official MCP registry. Results are de-duplicated and ranked so
 * the publisher's own server (e.g. com.notion/mcp for "notion") comes before
 * third-party wrappers and proxies.
 */
export async function searchRegistry(query: string, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<CatalogEntry[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${REGISTRY}?search=${encodeURIComponent(q)}&limit=40&version=latest`;
  const res = await (opts.fetchImpl ?? fetch)(url, { signal: opts.signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  const body = (await res.json()) as { servers?: ({ server?: RegistryServer } & RegistryServer)[] };
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const item of body.servers ?? []) {
    const entry = fromRegistry(item.server ?? item);
    if (!entry || seen.has(entry.registryName!)) continue;
    seen.add(entry.registryName!);
    out.push(entry);
  }
  const ql = q.toLowerCase();
  const score = (e: CatalogEntry) => {
    const id = e.registryName!.toLowerCase();
    let s = 0;
    if (POPULAR.some((p) => p.registryName?.toLowerCase() === id)) s -= 100;
    if (new RegExp(`(^|[./])${ql.replace(/[^a-z0-9]/g, '')}([./]|$)`).test(id.split('/')[0]!)) s -= 50; // publisher namespace matches
    if (e.name === ql) s -= 20;
    if (/^ai\.smithery\/|proxy|wrapper|fork/.test(id)) s += 30;
    if (e.needsEnv?.length) s += 5;
    return s;
  };
  return out.map((e, i) => ({ e, i })).sort((a, b) => score(a.e) - score(b.e) || a.i - b.i).map((x) => x.e).slice(0, 20);
}
