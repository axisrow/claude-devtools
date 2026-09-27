/**
 * Canonical token-accounting core of the fork — SINGLE SOURCE OF TRUTH.
 *
 * Pure functions, zero imports: safe to bundle into browser/renderer builds
 * and to run under bare node (the turn-budget hook imports this file). The
 * app consumes it only through src/shared/turnAccounting.ts; the calibration
 * CLI and the hook import it directly. Nobody re-implements this arithmetic.
 *
 * Naming contract:
 *  - inputSideTokens  = input + cache_read + cache_creation — what a turn
 *    re-reads; the currency of the turn-budget hook and its calibration.
 *  - billedTotalTokens = inputSide + output — a round's full billed cost.
 *  Bare "billed" appears only in billedRequestKey (request identity) and the
 *  billedTotal* family.
 *
 * Accepts both raw hook lines (usage/id under `.message`) and flattened
 * ParsedMessage (id at top level) wherever a message is consumed.
 */

/**
 * Which key identifies one billed request on this transcript: the backend's
 * requestId when present, else the API message.id (proxies that stream one
 * line per content block omit requestId but repeat message.id).
 */
export function billedRequestKey(m) {
  return m.requestId ?? m.messageId ?? m.message?.id;
}

/** Input-side usage: the portion a round re-reads from the provider. */
export function inputSideTokens(u) {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** Full billed cost of a round: input side plus generated output. */
export function billedTotalTokens(u) {
  if (!u) return 0;
  return inputSideTokens(u) + (u.output_tokens ?? 0);
}

/** Billed total of the first assistant rounds carrying usage (flattened shape). */
export function firstAssistantTotalTokens(responses) {
  for (const msg of responses ?? []) {
    if (msg.type === 'assistant' && msg.usage) return billedTotalTokens(msg.usage);
  }
  return 0;
}

/** Billed total of the last assistant round carrying usage (flattened shape). */
export function lastAssistantTotalTokens(responses) {
  const list = responses ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (msg.type === 'assistant' && msg.usage) return billedTotalTokens(msg.usage);
  }
  return 0;
}

/** Simplified teammate-message wrapper detection. */
function isTeammateText(t) {
  return t.startsWith('<teammate-message');
}

/** Real user message (raw hook line or flattened ParsedMessage): not meta,
 * not a teammate relay, not empty, not an interruption marker. */
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
  // billed once per request. Scanning newest-first, the first line seen per
  // key has the final counts (keep-newest).
  const billed = new Set();
  for (const line of linesNewestFirst) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (isTurnBoundary(m)) {
      boundaryFound = true;
      break;
    }
    if (m.type === 'assistant' && m.message?.usage) {
      const key = billedRequestKey(m);
      if (key) {
        if (billed.has(key)) continue;
        billed.add(key);
      }
      spent += inputSideTokens(m.message.usage);
    }
  }
  return { spent, boundaryFound };
}
