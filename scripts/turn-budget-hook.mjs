#!/usr/bin/env node
/**
 * Turn input-budget limiter — PreToolUse hook for Claude Code.
 *
 * Counts input-side tokens of the current turn (last real user message -> EOF)
 * in the session transcript; denies the next tool call once the budget is
 * spent, so the agent wraps up and reports instead of looping on.
 *
 * SINGLE SOURCE OF TRUTH: the pure accounting functions live in
 * ./turn-accounting.mjs (zero imports, browser-bundle-safe) and are
 * re-exported here. The app imports them only through
 * src/shared/turnAccounting.ts, the calibration CLI imports the predicates
 * directly — nobody re-implements the arithmetic. The file stays a plain
 * zero-dep .mjs pair because Claude Code runs the hook with bare node.
 *
 * Naming contract: inputSideTokens = input + cache_read + cache_creation
 * (what a turn re-reads — the hook's currency); billedTotalTokens =
 * inputSide + output (a round's full cost). Bare "billed" appears only in
 * billedRequestKey (request identity) and the billedTotal* family.
 *
 * Fail-open: any error exits 0 silently — a broken limiter must not break
 * sessions, and a spend counted without a found turn boundary allows too.
 * Note: Claude Code writes the transcript asynchronously, so the very last
 * round may be missing — the deny fires on the NEXT call based on rounds
 * already on disk. Acceptable undercount.
 */

import {
  appendFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// canonical accounting core — re-exported so the .d.mts on this file keeps
// covering the CLI and tests that import from the hook script directly
import {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  firstAssistantTotalTokens,
  inputSideTokens,
  isRealUserLine,
  isTurnBoundary,
  lastAssistantTotalTokens,
} from './turn-accounting.mjs';

export {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  firstAssistantTotalTokens,
  inputSideTokens,
  isRealUserLine,
  isTurnBoundary,
  lastAssistantTotalTokens,
};

const CONFIG_PATH = join(homedir(), '.claude', 'claude-devtools-config.json');
// corpus-calibrated with request dedup (pnpm turn-spend:stats, 10 423 turns,
// 2026-09-27): p95 = 6.66M -> budget = round to 0.5M of p95 x 1.2 = 8M.
// Same convention as the original 15M (12.56M p95 x 1.2, un-deduped count).
const DEFAULT_BUDGET = 8_000_000;
const CHUNK = 1 << 20; // backwards-read window

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
  if (hook.hook_event_name === 'UserPromptSubmit') {
    handleToggle(hook);
    return;
  }
  const { enabled, budget } = readConfig(readConfigSafely());
  if (!enabled || isSessionOff(hook.session_id)) return;

  const transcript = hook.transcript_path;
  if (typeof transcript !== 'string' || !existsSync(transcript)) return;

  let fd;
  let spent = 0;
  let boundaryFound = false;
  try {
    fd = openSync(transcript, 'r');
    const size = statSync(transcript).size;
    // Keep the request deduplication set for the whole turn, not one line.
    ({ spent, boundaryFound } = analyzeTurn(linesBackward(fd, size)));
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

// Per-session switch: a marker file per session id. Typing `budget off` /
// `budget on` as a prompt toggles it for THAT session only (long sessions).
const OFF_DIR = join(homedir(), '.claude', 'claude-devtools-turnbudget-off');

function offMarker(sessionId) {
  // ponytail: ids are UUIDs; reject anything else rather than sanitise
  return typeof sessionId === 'string' && /^[\w-]+$/.test(sessionId)
    ? join(OFF_DIR, sessionId)
    : null;
}

export function isSessionOff(sessionId) {
  const m = offMarker(sessionId);
  return m !== null && existsSync(m);
}

/** UserPromptSubmit: `budget on|off` flips the marker and swallows the prompt. */
function handleToggle(hook) {
  const m = /^\s*budget\s+(on|off)\s*$/i.exec(hook.prompt ?? '');
  const marker = offMarker(hook.session_id);
  if (!m || !marker) return;
  const off = m[1].toLowerCase() === 'off';
  try {
    if (off) {
      mkdirSync(OFF_DIR, { recursive: true });
      writeFileSync(marker, '');
    } else {
      rmSync(marker, { force: true });
    }
  } catch {
    return; // fail-open: prompt goes through to the model
  }
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `Turn budget hook ${off ? 'OFF' : 'ON'} for this session.`,
    })
  );
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
