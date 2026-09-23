/**
 * importLoops CLI — backfill the notification bell with historical loop
 * incidents from the transcript corpus.
 *
 * Light scan (sessionInventory.scanSessionFile) -> filter by run length ->
 * merge into ~/.claude/claude-devtools-notifications.json. Idempotent:
 * previous imports carry triggerId 'historical-loop' and are replaced on
 * each run, so threshold changes re-import cleanly.
 *
 * Flags: --min-cycle N (default 20), --dry-run.
 * The bell reads the file at app startup — restart the app after import.
 */

import { extractProjectName } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { wantsHelp } from './args';
import { scanSessionFile } from './sessionInventory';

const NOTIFICATIONS_PATH = path.join(os.homedir(), '.claude', 'claude-devtools-notifications.json');
const HISTORICAL_TAG = 'historical-loop';
const BELL_CAP = 100;

interface StoredLike {
  id: string;
  timestamp: number;
  triggerId?: string;
}

interface ImportedLoop {
  id: string;
  timestamp: number;
  sessionId: string;
  projectId: string;
  filePath: string;
  source: string;
  message: string;
  toolUseId?: string;
  triggerId: string;
  triggerName: string;
  context: { projectName: string; cwd?: string };
  isRead: boolean;
  createdAt: number;
}

// ===========================================================================
// Pure core (exported for tests)
// ===========================================================================

/** Scan results -> importable loop notifications, filtered by run length. */
export function buildImportEntries(
  found: {
    sessionId: string;
    projectId: string;
    filePath: string;
    cwd?: string;
    cycles: { key: string; count: number; startTs: string; toolUseId: string }[];
  }[],
  minCycle: number
): ImportedLoop[] {
  const out: ImportedLoop[] = [];
  for (const f of found) {
    for (const c of f.cycles) {
      if (c.count < minCycle) continue;
      const startMs = Date.parse(c.startTs);
      if (!Number.isFinite(startMs)) continue;
      out.push({
        id: `historical-loop-${f.sessionId}-${c.count}x-${c.startTs}`,
        timestamp: startMs,
        sessionId: f.sessionId,
        projectId: f.projectId,
        filePath: f.filePath,
        source: 'loop',
        message: `${c.key} ×${c.count} — possible stuck loop`,
        toolUseId: c.toolUseId || undefined,
        triggerId: HISTORICAL_TAG,
        triggerName: 'Loop (historical)',
        context: { projectName: extractProjectName(f.projectId, f.cwd) },
        isRead: false,
        createdAt: Date.now(),
      });
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Merge incoming entries into the bell store: previous imports (triggerId
 * 'historical-loop') are replaced wholesale, live notifications stay, newest
 * first, capped.
 */
export function mergeImport(
  existing: StoredLike[],
  incoming: ImportedLoop[],
  cap = BELL_CAP
): StoredLike[] {
  const kept = existing.filter((n) => n.triggerId !== HISTORICAL_TAG);
  const merged = [...kept, ...(incoming as StoredLike[])].sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, cap);
}

// ===========================================================================
// CLI
// ===========================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log('Usage: pnpm loops:import [--min-cycle N] [--dry-run]');
    return;
  }

  let minCycle = 20;
  const minCycleIdx = argv.indexOf('--min-cycle');
  if (minCycleIdx !== -1) {
    minCycle = parseInt(argv[minCycleIdx + 1] ?? '', 10) || 20;
  }
  const dryRun = argv.includes('--dry-run');

  console.log(`Scanning corpus (min cycle ${minCycle})...`);
  const found: Parameters<typeof buildImportEntries>[0] = [];
  let fileCount = 0;
  const base = path.join(os.homedir(), '.claude', 'projects');

  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(base, dir.name);
    let files: fs.Dirent[] = [];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
      const entry = await scanSessionFile(path.join(projectPath, f.name)).catch(() => null);
      fileCount++;
      if (!entry) continue;
      if (entry.cycles.some((c) => c.count >= minCycle)) found.push(entry);
    }
  }

  const incoming = buildImportEntries(found, minCycle);
  console.log(`scanned ${fileCount} files, ${incoming.length} loops at >= ${minCycle}x`);

  if (dryRun) {
    console.log('dry run — nothing written');
    return;
  }

  let existing: StoredLike[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')) as StoredLike[];
  } catch {
    existing = [];
  }
  const merged = mergeImport(existing, incoming);
  fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log('Restart the app to see imported loops in the bell.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
