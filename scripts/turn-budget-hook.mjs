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
 *
 * Stop-crane (#142): a deny tells the model to finish the turn. When it calls
 * a tool again in the same run anyway — a deny already came back and no real
 * prompt arrived since (compaction, task wake-ups and subagent prompts don't
 * end a run) — the hook denies the call and stops the run (continue:false)
 * instead of one more soft deny. The transcript is the state: Claude Code
 * writes every deny back as an errored tool_result. A new prompt (human or
 * orchestrator) starts afresh.
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
  isMainChainAssistantLine,
  isRealUserLine,
  isTurnBoundary,
  isTurnNumberLine,
  isUserChunkLine,
  lastAssistantTotalTokens,
} from './turn-accounting.mjs';

export {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  firstAssistantTotalTokens,
  inputSideTokens,
  isMainChainAssistantLine,
  isRealUserLine,
  isTurnBoundary,
  isTurnNumberLine,
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
// Stop-crane (#142)
// =============================================================================

// the deny reason's stable head — one owner: deny() writes it, the crane reads
// it back from the transcript
const DENY_MARKER = 'Turn input budget exhausted';
// how Claude Code writes a hook deny back (probed on CC 2.1.302):
// "PreToolUse:<Tool> hook error: <permissionDecisionReason>", is_error: true —
// anchored, so a failed command that merely prints the marker is no deny
const DENY_RESULT_RE = new RegExp(`^PreToolUse:\\S+ hook error: ${DENY_MARKER}`);
// ponytail: calibration knob, not config — ignored deny rounds tolerated
// before the stop (0 = stop at the first tool call after a seen deny)
const CRANE_GRACE_ROUNDS = 0;

/** A budget deny written back by Claude Code: an errored main-chain
 * tool_result in DENY_RESULT_RE form (a Read/grep of this file is no error). */
export function isBudgetDenyLine(m) {
  if (m.type !== 'user' || m.isSidechain === true) return false;
  const c = m.message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b) => {
    if (b?.type !== 'tool_result' || b.is_error !== true) return false;
    const text =
      typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((x) => x?.text ?? '').join('\n')
          : '';
    return DENY_RESULT_RE.test(text);
  });
}

/**
 * Denied rounds the model has already seen in this run: scans newest-first
 * back to the last real prompt. Denies newer than the newest round are its
 * own parallel siblings — the model never saw those.
 * ponytail: while the current round is not on disk yet, the previous round's
 * denies read as siblings — the crane fires one round later (fail-soft).
 */
export function deliveredDenyRounds(linesNewestFirst) {
  const denied = new Set();
  let seen = false;
  let newestKey;
  let pending = 0;
  for (const line of linesNewestFirst) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    // a real prompt starts the run; compaction is no prompt (unlike the budget bucket)
    if (m.isSidechain !== true && isUserChunkLine(m)) break;
    if (isBudgetDenyLine(m)) {
      pending++;
      continue;
    }
    if (!isMainChainAssistantLine(m)) continue;
    const key = billedRequestKey(m);
    if (!seen || key === newestKey) {
      seen = true;
      newestKey = key;
      pending = 0;
      continue;
    }
    // denies above this older round came back before the newest round was made
    if (pending > 0) denied.add(key);
    pending = 0;
  }
  return denied.size;
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
  let ignored = 0;
  try {
    fd = openSync(transcript, 'r');
    const size = statSync(transcript).size;
    // Keep the request deduplication set for the whole turn, not one line.
    ({ spent, boundaryFound } = analyzeTurn(linesBackward(fd, size)));
    // only an over-budget call pays for the stop-crane's second scan
    if (boundaryFound && spent >= budget) ignored = deliveredDenyRounds(linesBackward(fd, size));
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
    if (ignored > CRANE_GRACE_ROUNDS) {
      logDecision(hook.session_id, spent, budget, true, 'crane');
      crane(spent, budget);
      return;
    }
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

/** The soft deny: the tool does not run, the model gets the reason back. */
function denyOutput(spent, budget) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${DENY_MARKER}: ~${Math.round(spent / 1e6)}M / ${Math.round(budget / 1e6)}M tokens re-read this turn. Finish the turn now: report results and stop.`,
    },
  };
}

export function deny(spent, budget) {
  process.stdout.write(JSON.stringify(denyOutput(spent, budget)));
}

/** Stop-crane: deny the call AND end the run. continue:false alone still runs
 * the tool before stopping (probed on CC 2.1.302) — the deny keeps it from
 * executing, and its write-back keeps a later wake-up in the crane. */
function crane(spent, budget) {
  process.stdout.write(
    JSON.stringify({
      continue: false,
      stopReason: `Turn budget stop-crane: tools kept being called after the budget deny (~${Math.round(spent / 1e6)}M / ${Math.round(budget / 1e6)}M re-read this turn, no new prompt since). Stopped — send a new prompt to continue, or "budget off" for this session.`,
      ...denyOutput(spent, budget),
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
