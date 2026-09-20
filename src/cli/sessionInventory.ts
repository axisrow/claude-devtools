/**
 * Sessions inventory CLI — duration, models, token totals across all sessions.
 * Answers "which sessions ran 2h+, on which model" without opening the app.
 *
 * Usage:
 *   pnpm analyze:sessions [--project <dir|encoded>] [--min-minutes N] [--sort duration|tokens|date] [--limit N] [--json]
 */

import { decodePath, extractSessionId, getProjectsBasePath } from '@main/utils/pathDecoder';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { pathToFileURL } from 'url';

import {
  billingFromFlags,
  type BillingScheme,
  dur,
  pad,
  padL,
  resolveProjectDir,
  short,
  takeFlagValue,
} from './analyzeSession';

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ScanEntry {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: { model?: string; usage?: RawUsage };
}

function mergeUsage(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

export interface InventoryEntry {
  projectId: string;
  sessionId: string;
  filePath: string;
  durationMs: number;
  lastTs: Date | null;
  models: string[];
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  sizeBytes: number;
  billing: BillingScheme;
}

// ponytail: own streaming pass instead of parseJsonlFile — it materializes every
// ParsedMessage and that measurably blows up on 1200+ files incl. 66MB ones
export async function scanSessionFile(filePath: string): Promise<InventoryEntry | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let messageCount = 0;
  const models = new Set<string>();
  // anthropic-style rounds report cache writes; routers report cache_read with cw=0
  let sawWrite = false;
  let sawRead = false;
  const usageByRequestId = new Map<string, RawUsage>();
  let directUsage: RawUsage = {};

  for await (const line of rl) {
    if (line === '') continue;
    let e: ScanEntry;
    try {
      e = JSON.parse(line) as ScanEntry;
    } catch {
      continue;
    }
    if (!e.timestamp) continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
    if (e.type === 'user' || e.type === 'assistant') messageCount++;

    if (e.type === 'assistant' && e.message?.usage && e.message.model !== '<synthetic>') {
      if (e.message.model) models.add(e.message.model);
      if (e.message.usage.cache_creation_input_tokens) sawWrite = true;
      else if (e.message.usage.cache_read_input_tokens) sawRead = true;
      // streaming writes several entries per request — the last one has final counts
      if (e.requestId) usageByRequestId.set(e.requestId, e.message.usage);
      else directUsage = mergeUsage(directUsage, e.message.usage);
    }
  }

  if (firstTs === null || lastTs === null) return null;

  let totals: RawUsage = directUsage;
  for (const u of usageByRequestId.values()) totals = mergeUsage(totals, u);

  const rel = path.relative(getProjectsBasePath(), path.resolve(filePath));
  const [projectId = '', sessionId = ''] = rel.split(path.sep);

  const inputTokens = totals.input_tokens ?? 0;
  const outputTokens = totals.output_tokens ?? 0;
  const cacheReadTokens = totals.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = totals.cache_creation_input_tokens ?? 0;

  return {
    projectId,
    sessionId: extractSessionId(sessionId),
    filePath,
    durationMs: Math.max(0, lastTs - firstTs),
    lastTs: new Date(lastTs),
    models: [...models],
    messageCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    sizeBytes: fs.statSync(filePath).size,
    billing: billingFromFlags(sawWrite, sawRead),
  };
}

async function listSessionFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(projectDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
      out.push(path.join(projectDir, e.name));
    }
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>
): Promise<(R | null)[]> {
  // ponytail: result order is nondeterministic — rows are sorted downstream anyway
  const results: (R | null)[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        results.push(await fn(item));
      } catch (err) {
        // one unreadable file must not abort a 1200+-file scan
        console.error(`(skipped ${item}: ${String(err)})`);
        results.push(null);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function collect(projectsRoot: string, projectArg?: string): Promise<InventoryEntry[]> {
  let dirs: string[];
  if (projectArg) {
    dirs = [projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const fileGroups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const files = fileGroups.filter((g): g is string[] => g !== null).flat();
  // ponytail: no mtime cache yet — first full scan is IO-bound seconds, add one if it hurts
  const scanned = await mapWithConcurrency(files, 8, scanSessionFile);
  return scanned.filter((e): e is InventoryEntry => e !== null);
}

const shortenHome = (p: string): string => {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'usage: pnpm analyze:sessions [--project <dir|encoded>] [--min-minutes N] [--sort duration|tokens|date] [--limit N] [--json]'
    );
    return;
  }
  let projectArg: string | undefined;
  let minMinutes = 0;
  let sort: 'duration' | 'tokens' | 'date' = 'duration';
  let limit = Number.POSITIVE_INFINITY;
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--project') {
      projectArg = value;
      i = next;
      continue;
    }
    if (a === '--min-minutes') {
      minMinutes = parseInt(value, 10) || 0;
      i = next;
      continue;
    }
    if (a === '--sort') {
      sort = value === 'tokens' || value === 'date' ? value : 'duration';
      i = next;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(value, 10);
      limit = n > 0 ? n : Number.POSITIVE_INFINITY;
      i = next;
      continue;
    }
    if (a === '--json') {
      json = true;
      i += 1;
      continue;
    }
    i += 1;
  }

  let projectDir: string | undefined;
  if (projectArg) {
    projectDir = resolveProjectDir(projectArg);
    if (!fs.existsSync(projectDir)) {
      console.error(`project dir not found: ${projectDir}`);
      process.exitCode = 1;
      return;
    }
  }

  const entries = await collect(getProjectsBasePath(), projectDir);
  entries.sort((a, b) => {
    if (sort === 'tokens') return b.totalTokens - a.totalTokens;
    if (sort === 'date') return (b.lastTs?.getTime() ?? 0) - (a.lastTs?.getTime() ?? 0);
    return b.durationMs - a.durationMs;
  });
  const shown = entries.filter((e) => e.durationMs >= minMinutes * 60000).slice(0, limit);

  if (json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  const minNote = minMinutes > 0 ? ` (>= ${String(minMinutes)} min)` : '';
  console.log(`sessions: ${entries.length} total, showing ${shown.length}${minNote}`);
  console.log();
  console.log(
    `${padL('duration', 9)} ${pad('date', 11)} ${pad('file', 9)} ${pad('project', 42)} ${pad('models', 30)} ${padL('tokens', 9)} ${padL('msgs', 6)} ${pad('billing', 15)}`
  );
  for (const e of shown) {
    const project = shortenHome(decodePath(e.projectId));
    const models = e.models.join(', ');
    console.log(
      `${padL(dur(e.durationMs), 9)} ${pad(e.lastTs ? e.lastTs.toISOString().slice(0, 10) : 'n/a', 11)} ${pad(e.sessionId.slice(0, 8), 9)} ${pad(short(project, 42), 42)} ${pad(short(models, 30), 30)} ${padL(formatTokensCompact(e.totalTokens), 9)} ${padL(String(e.messageCount), 6)} ${pad(e.billing, 15)}`
    );
  }
}

// run only when executed directly — vitest imports this file for scanSessionFile
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
