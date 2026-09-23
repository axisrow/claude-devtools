#!/usr/bin/env node
/**
 * Turn input-budget limiter — PreToolUse hook for Claude Code.
 *
 * Counts input-side tokens of the current turn (last real user message -> EOF)
 * in the session transcript; denies the next tool call once the budget is
 * spent, so the agent wraps up and reports instead of looping on.
 *
 * Fail-open: any error exits 0 silently — a broken limiter must not break
 * sessions.
 */

import { openSync, readSync, closeSync, readFileSync, statSync, existsSync } from 'node:fs';
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

/** Sum input-side tokens of the current turn, scanning lines newest-first. */
export function analyzeTurn(linesNewestFirst, budget) {
  let spent = 0;
  let boundaryFound = false;
  for (const line of linesNewestFirst) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRealUserLine(m)) {
      boundaryFound = true;
      break;
    }
    if (m.type === 'assistant' && m.message?.usage) {
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
    const tb = cfg.turnBudget ?? {};
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
  try {
    fd = openSync(transcript, 'r');
    const size = statSync(transcript).size;
    for (const line of linesBackward(fd, size)) {
      const { spent: s, boundaryFound } = analyzeTurn([line], budget);
      spent += s;
      if (boundaryFound) break;
    }
  } catch {
    // fail-open
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (spent >= budget) {
    deny(spent, budget);
  }
}

function readConfigSafely() {
  try {
    return readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return '';
  }
}

function deny(spent, budget) {
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