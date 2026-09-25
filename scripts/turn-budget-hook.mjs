#!/usr/bin/env node
/**
 * Turn input-budget limiter — PreToolUse hook for Claude Code.
 *
 * Counts input-side tokens of the current turn (last real user message -> EOF)
 * in the session transcript; denies the next tool call once the budget is
 * spent, so the agent wraps up and reports instead of looping on.
 *
 * Fail-open: any error exits 0 silently — a broken limiter must not break
 * sessions, and a spend counted without a found turn boundary allows too.
 * Note: Claude Code writes the transcript asynchronously, so the very last
 * round may be missing — the deny fires on the NEXT call based on rounds
 * already on disk. Acceptable undercount.
 */

import {
  appendFileSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.claude', 'claude-devtools-config.json');
// corpus-calibrated (pnpm turn-spend:stats, 10 080 turns): p95 = 12.56M
const DEFAULT_BUDGET = 15_000_000;
const CHUNK = 1 << 20; // backwards-read window

/** Simplified teammate-message wrapper detection. */
function isTeammateText(t) {
  return t.startsWith('<teammate-message');
}

/** Simplified mirror of isParsedUserChunkMessage (main/types/messages.ts). */
export function isRealUserLine(m) {
  if (m.type !== 'user' || m.isMeta === true) return false;
  // raw JSONL lines wrap content in .message (ParsedMessage flattens it)
  const c = (m.message ?? m).content;
  if (typeof c === 'string') {
    const t = c.trim();
    if (t === '' || t.startsWith('[Request interrupted')) return false;
    return !isTeammateText(t);
  }
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b && (b.type === 'text' || b.type === 'image')) {
        if (b.type === 'text' && (isTeammateText(b.text ?? '') || (b.text ?? '').trim() === '' || (b.text ?? '').trim().startsWith('[Request interrupted'))) {
          continue;
        }
        return true;
      }
    }
    return false;
  }
  return false;
}

/** Turn boundary: a real user message — or a compaction marker (the
 * post-compact context starts fresh, pre-compact spend must not count).
 * The calibration CLI (src/cli/turnSpendStats.ts) imports this exact
 * predicate so both accountings cannot drift. */
export function isTurnBoundary(m) {
  return isRealUserLine(m) || m.isCompactSummary === true;
}

/** Sum input-side tokens of the current turn, scanning lines newest-first. */
export function analyzeTurn(linesNewestFirst) {
  let spent = 0;
  let boundaryFound = false;
  // streaming writes several JSONL lines per API request, each carrying usage —
  // billed once per request (same key as main/utils/jsonl.ts billedRequestKey).
  // Scanning newest-first, the first line seen per key has the final counts.
  const billed = new Set();
  for (const line of linesNewestFirst) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    // turn boundary: see isTurnBoundary above
    if (isTurnBoundary(m)) {
      boundaryFound = true;
      break;
    }
    if (m.type === 'assistant' && m.message?.usage) {
      const key = m.message.requestId ?? m.message.id;
      if (key) {
        if (billed.has(key)) continue;
        billed.add(key);
      }
      const u = m.message.usage;
      spent += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  return { spent, boundaryFound };
}

/** Backwards line generator: yields lines newest-first. */
export function* linesBackward(fd, size) {
  const buf = Buffer.alloc(CHUNK);
  let remaining = size;
  let carry = '';
  while (remaining > 0) {
    const len = Math.min(CHUNK, remaining);
    remaining -= len;
    readSync(fd, buf, 0, len, remaining);
    const text = buf.toString('utf8', 0, len) + carry;
    const parts = text.split('\n');
    carry = parts.shift() ?? '';
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]) yield parts[i];
    }
  }
  if (carry) yield carry;
}

/** Read turnBudget config; defaults when missing. */
export function readConfig(raw) {
  try {
    const cfg = JSON.parse(raw ?? '{}');
    // ConfigManager writes it under notifications.turnBudget, not top level
    const tb = cfg.notifications?.turnBudget ?? {};
    return {
      enabled: tb.enabled !== false,
      budget: Number.isInteger(tb.maxInputTokensPerTurn) ? tb.maxInputTokensPerTurn : DEFAULT_BUDGET,
    };
  } catch {
    return { enabled: true, budget: DEFAULT_BUDGET };
  }
}

// =============================================================================
// Entry
// =============================================================================

export function main() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    return;
  }
  const { enabled, budget } = readConfig(readConfigSafely());
  if (!enabled) return;

  const transcript = hook.transcript_path;
  if (typeof transcript !== 'string' || !existsSync(transcript)) return;

  let fd;
  let spent = 0;
  let boundaryFound = false;
  try {
    fd = openSync(transcript, 'r');
    const size = statSync(transcript).size;
    for (const line of linesBackward(fd, size)) {
      const r = analyzeTurn([line]);
      spent += r.spent;
      if (r.boundaryFound) {
        boundaryFound = true;
        break;
      }
    }
  } catch {
    // fail-open
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  if (!boundaryFound) {
    // a spend counted without a turn boundary is not trustworthy (that was
    // the 872M incident) — allow, but leave an anomaly line in the log
    logDecision(hook.session_id, spent, budget, false, 'no-boundary');
    return;
  }
  if (spent >= budget) {
    logDecision(hook.session_id, spent, budget, true, 'deny');
    deny(spent, budget);
  }
}

const LOG_PATH = join(homedir(), '.claude', 'claude-devtools-turnbudget.log');

/** Append deny/anomaly decisions only — routine allows stay silent. */
function logDecision(sessionId, spent, budget, denied, kind) {
  try {
    appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} kind=${kind} session=${sessionId ?? '?'} spent=${spent} budget=${budget} denied=${denied}\n`
    );
  } catch {
    // logging must never break the hook
  }
}

function readConfigSafely() {
  try {
    return readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return '';
  }
}

export function deny(spent, budget) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Turn input budget exhausted: ~${Math.round(spent / 1e6)}M / ${Math.round(budget / 1e6)}M tokens re-read this turn. Finish the turn now: report results and stop.`,
      },
    })
  );
}

if (process.argv[1] && process.argv[1].endsWith('turn-budget-hook.mjs')) {
  try {
    main();
  } catch {
    // fail-open: a broken limiter must never block a session
  }
}