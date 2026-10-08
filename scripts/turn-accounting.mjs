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

/** Complete <teammate-message ...>...</teammate-message> block — the exact
 * regex the display parser (src/shared/utils/teammateMessageParser.ts)
 * re-uses, so relay detection and card rendering cannot drift. */
export const TEAMMATE_BLOCK_RE =
  /<teammate-message\s+teammate_id="([^"]+)"([^>]*)>([\s\S]*?)<\/teammate-message>/g;

/** Text minus every complete relay block (issue #59): whatever remains is
 * user text, so mixed content stays a user message. */
export function stripTeammateBlocks(t) {
  return t.replace(new RegExp(TEAMMATE_BLOCK_RE.source, TEAMMATE_BLOCK_RE.flags), '');
}

/** Relay text = ONLY complete relay wrappers (plus whitespace). A prompt that
 * merely starts with a wrapper (quote, trailing question) is user text —
 * not a relay. */
function isTeammateText(t) {
  const trimmed = t.trim();
  return trimmed !== '' && stripTeammateBlocks(trimmed).trim() === '';
}

/** System-output wrapper tags — a user line starting with one of these is
 * system-generated output, not user input (canonical list; the app's
 * messageTags.ts re-exports it). */
export const SYSTEM_OUTPUT_TAGS = [
  '<local-command-stderr>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<system-reminder>',
];

/**
 * Canonical user-line predicate: a user message that starts a new turn.
 * Port of isParsedUserChunkMessage (main/types/messages.ts), which now
 * delegates here — one definition, no drift. System output (stdout/stderr/
 * caveat/system-reminder) and teammate relays do NOT start a hook turn;
 * relays are transcript turns — see isTeammateRelayLine / isTranscriptTurnLine.
 * user-initiated slash commands (<command-name>) DO.
 */
export function isUserChunkLine(m) {
  if (m.type !== 'user' || m.isMeta === true) return false;
  // one relay definition, no hand-synced copies: the string/array relay
  // exclusions below and isTeammateRelayLine are the same two checks
  if (isTeammateRelayLine(m)) return false;
  // raw JSONL lines wrap content in .message (ParsedMessage flattens it)
  const c = (m.message ?? m).content;
  if (typeof c === 'string') {
    const t = c.trim();
    if (t === '' || t.startsWith('[Request interrupted')) return false;
    for (const tag of SYSTEM_OUTPUT_TAGS) {
      if (t.startsWith(tag)) return false;
    }
    return true;
  }
  if (Array.isArray(c)) {
    const hasUserContent = c.some((b) => b && (b.type === 'text' || b.type === 'image'));
    if (!hasUserContent) return false;
    // a lone "[Request interrupted ...]" text block is part of the AI flow,
    // not a new user turn
    if (
      c.length === 1 &&
      c[0].type === 'text' &&
      typeof c[0].text === 'string' &&
      c[0].text.trim().startsWith('[Request interrupted')
    ) {
      return false;
    }
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        const t = b.text.trim();
        for (const tag of SYSTEM_OUTPUT_TAGS) {
          if (t.startsWith(tag)) return false;
        }
      }
    }
    return true;
  }
  return false;
}

/**
 * Teammate relay: a non-meta user line whose content consists solely of
 * complete <teammate-message ...> wrappers — inter-agent traffic. Mixed
 * content (a relay block plus user text, issue #59) is a user message, so
 * the user's words survive. The single relay definition: isUserChunkLine
 * delegates its relay exclusion here, so the two predicates cannot drift.
 * Transcript turn input (isTranscriptTurnLine) but NOT a hook-turn boundary
 * (isUserChunkLine) — the relay bills to the leader's turn (issue #55).
 */
export function isTeammateRelayLine(m) {
  if (m.type !== 'user' || m.isMeta === true) return false;
  const c = (m.message ?? m).content;
  const texts =
    typeof c === 'string'
      ? [c]
      : Array.isArray(c)
        ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
        : [];
  // whole-content rule across blocks: a relay block next to user text keeps
  // the line a user message
  return isTeammateText(texts.join('\n'));
}

/**
 * Transcript turn input: a real user message or a teammate relay. The
 * semantics jsonl.ts turnCount and the chat Turn N chips implement —
 * strictly wider than the hook's isUserChunkLine, which relays must not
 * open.
 */
export function isTranscriptTurnLine(m) {
  return isUserChunkLine(m) || isTeammateRelayLine(m);
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

/** Turn boundary: a user-initiated message (system output and teammate
 * relays don't count) — or a compaction marker (the post-compact context
 * starts fresh, pre-compact spend must not count). The calibration CLI
 * (src/cli/turnSpendStats.ts) imports this exact predicate so both
 * accountings cannot drift. */
export function isTurnBoundary(m) {
  return isUserChunkLine(m) || m.isCompactSummary === true;
}

/** Main-chain assistant line — the only lines whose usage is billed to the
 * turn's re-read. Sidechain (subagent) rounds run in their own context and
 * synthetic lines carry no real request; the detector (loopDetection.ts)
 * and the panel's aiGroups never see them, so the hook must not either —
 * one definition, no drift. */
export function isMainChainAssistantLine(m) {
  return (
    m.type === 'assistant' && m.isSidechain !== true && m.message?.model !== '<synthetic>'
  );
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
    if (isMainChainAssistantLine(m) && m.message?.usage) {
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
