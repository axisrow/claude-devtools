/**
 * Independent reference for the golden real-session fixture (#74).
 *
 * DELIBERATELY imports nothing from src/ or scripts/: it re-implements the
 * billing spec from scratch so that a wrong formula or price that every
 * consumer shares (and every parity test asserts) still fails here.
 *
 * Spec (canonical: scripts/teammate-message handling in turn-accounting.mjs,
 * src/shared/utils/pricing.ts):
 *  - one billed request = requestId ?? message.id, assistant lines only; the
 *    request's last line with usage holds the final counters
 *  - app tokens = every deduped assistant round with usage (sidechain and
 *    <synthetic> included)
 *  - ledger/hook scope = main chain only: assistant, !isSidechain, model !==
 *    '<synthetic>'
 *  - hook input side = input + cache_read + cache_creation, per turn; turns
 *    split at user-initiated messages and compaction markers
 *  - prices hand-copied 2026-10-12: claude.com/pricing (sonnet-5 2/10/0.2/2.5/4,
 *    opus-5 5/25/0.5/6.25/10 USD/MTok), GLM from src/shared/utils/pricing.ts
 *    (z.ai / OpenRouter) 0.075/0.015/0.075 rows; unpriced (deepseek router
 *    alias) excluded, flags cost partial
 *
 * Usage: node reference.mjs           → totals JSON on stdout
 *        node reference.mjs --write   → also rewrites verified file
 * Re-run --write after a fixture refresh; review the diff by hand.
 */
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const msgs = readFileSync(new URL("session.jsonl", here), "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l));

// --- spec predicates (deliberate near-duplicates, see header) ---------------
// The fixture has no teammate relays (grep: 0), so the relay rule is identity
// here; the canonical stripTeammateBlocks check in scripts/turn-accounting.mjs
// must be re-added if a relayed fixture is ever used.

const TAGS = [
  "<local-command-stderr>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<task-notification>",
];

const hasUserText = (t) => {
  const trimmed = t.trim();
  if (trimmed === "" || trimmed.startsWith("[Request interrupted"))
    return false;
  for (const tag of TAGS) if (trimmed.startsWith(tag)) return false;
  return true;
};

const isUserTurnLine = (m) => {
  if (m.type !== "user" || m.isMeta === true) return false;
  const c = (m.message ?? m).content;
  if (typeof c === "string") return hasUserText(c);
  if (Array.isArray(c)) {
    if (!c.some((b) => b && (b.type === "text" || b.type === "image")))
      return false;
    for (const b of c) {
      if (
        b &&
        b.type === "text" &&
        typeof b.text === "string" &&
        hasUserText(b.text)
      )
        return true;
    }
    return false;
  }
  return false;
};

const isBoundary = (m) =>
  m.isSidechain !== true && (isUserTurnLine(m) || m.isCompactSummary === true);
const isMainChainRound = (m) =>
  m.type === "assistant" &&
  m.isSidechain !== true &&
  m.message?.model !== "<synthetic>";
const inputSideOf = (u) =>
  (u.input_tokens ?? 0) +
  (u.cache_read_input_tokens ?? 0) +
  (u.cache_creation_input_tokens ?? 0);

const PRICES = {
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cw5m: 2.5,
    cw1h: 4,
  },
  "claude-opus-5": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cw5m: 6.25,
    cw1h: 10,
  },
  glm: {
    input: 0.075,
    output: 0.25,
    cacheRead: 0.015,
    cw5m: 0.075,
    cw1h: 0.075,
  },
};
const priceFor = (m) =>
  m === "claude-sonnet-5" || m === "claude-opus-5"
    ? PRICES[m]
    : m.startsWith("glm-")
      ? PRICES.glm
      : null;

const byKey = new Map();
const keyless = [];
for (const m of msgs) {
  if (
    m.type !== "assistant" ||
    m.isSidechain === true ||
    m.message?.model === "<synthetic>"
  )
    continue;
  if (!m.message?.usage) continue;
  const key = m.requestId ?? m.message?.id ?? null;
  if (key) byKey.set(key, m);
  else keyless.push(m);
}

const mainRounds = [...byKey.values(), ...keyless].filter(isMainChainRound);
let costUsd = 0;
let costPartial = false;
for (const m of [...byKey.values(), ...keyless]) {
  const u = m.message.usage;
  const p = priceFor(m.message.model);
  if (!p) {
    costPartial = true;
    continue;
  }
  const cw = u.cache_creation_input_tokens ?? 0;
  const split = cw > 0 ? u.cache_creation : undefined;
  const cw5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : cw;
  const cw1h = split ? (split.ephemeral_1h_input_tokens ?? 0) : 0;
  const mine =
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      cw5m * p.cw5m +
      cw1h * p.cw1h) /
    1e6;
  costUsd += mine;
}
// --- app scope: ALL assistant rounds (sidechain + synthetic included) -------

const appBy = new Map();
const appKeyless = [];
for (const m of msgs) {
  if (m.type !== "assistant" || !m.message?.usage) continue;
  const key = m.requestId ?? m.message?.id ?? null;
  if (key) appBy.set(key, m);
  else appKeyless.push(m);
}

const columns = (usages) => {
  const c = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  for (const u of usages) {
    c.input += u.input_tokens ?? 0;
    c.cacheRead += u.cache_read_input_tokens ?? 0;
    c.cacheCreation += u.cache_creation_input_tokens ?? 0;
    c.output += u.output_tokens ?? 0;
  }
  return c;
};
// --- hook: per-turn input side ----------------------------------------------

const perTurn = [];
let current = null;
let currentKeyed = new Map();
const flush = () => {
  if (current === null) return;
  let total = current;
  for (const u of currentKeyed.values()) total += inputSideOf(u);
  perTurn.push(total);
};
for (const m of msgs) {
  if (isBoundary(m)) {
    flush();
    current = 0;
    currentKeyed = new Map();
    continue;
  }
  if (!isMainChainRound(m)) continue;
  const u = m.message.usage;
  if (!u) continue;
  const key = m.requestId ?? m.message?.id ?? null;
  if (key) currentKeyed.set(key, u);
  else current += inputSideOf(u);
}
flush();
// --- fixture phenomena (pinned sanity counts, mirrors the test's scan) -------

const models = new Set();
const requestLines = new Map();
let fixtureCompactLines = 0;
let fixtureSidechainLines = 0;
let fixture1hRounds = 0;
let fixtureSyntheticLines = 0;
for (const m of msgs) {
  if (m.isCompactSummary === true) fixtureCompactLines++;
  if (m.isSidechain === true) fixtureSidechainLines++;
  if (m.type !== "assistant") continue;
  const key = m.requestId ?? m.message?.id;
  if (key) requestLines.set(key, (requestLines.get(key) ?? 0) + 1);
  if (m.message?.model) models.add(m.message.model);
  if (m.message?.model === "<synthetic>") fixtureSyntheticLines++;
  if ((m.message?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0)
    fixture1hRounds++;
}
// --- ledger turns + assembly -------------------------------------------------

let ledgerTurns = 0;
for (const m of msgs) {
  if (m.isCompactSummary === true) continue;
  if (m.isSidechain === true) continue;
  if (isUserTurnLine(m)) ledgerTurns++;
}
const mainCols = columns(mainRounds.map((m) => m.message.usage));
const appCols = columns(
  [...appBy.values(), ...appKeyless].map((m) => m.message.usage)
);

const result = {
  fixture: {
    lines: msgs.length,
    models: [...models].sort(),
    fragmentGroups: [...requestLines.values()].filter((n) => n > 1).length,
    compactLines: fixtureCompactLines,
    sidechainLines: fixtureSidechainLines,
    cacheWrite1hRounds: fixture1hRounds,
    syntheticLines: fixtureSyntheticLines,
  },
  ledger: {
    turns: ledgerTurns,
    inputTokens: mainCols.input,
    cacheReadTokens: mainCols.cacheRead,
    cacheCreationTokens: mainCols.cacheCreation,
    outputTokens: mainCols.output,
    billedTokens:
      mainCols.input + mainCols.cacheRead + mainCols.cacheCreation + mainCols.output,
  },
  app: {
    inputTokens: appCols.input,
    cacheReadTokens: appCols.cacheRead,
    cacheCreationTokens: appCols.cacheCreation,
    outputTokens: appCols.output,
    totalTokens:
      appCols.input + appCols.cacheRead + appCols.cacheCreation + appCols.output,
  },
  cost: { usd: costUsd, partial: costPartial },
  hook: {
    turns: perTurn.length,
    perTurnInputSide: perTurn,
    inputSideTotal: perTurn.reduce((a, b) => a + b, 0),
  },
};

if (process.argv.includes("--write")) {
  const doc = { provenance: "reference.mjs output over session.jsonl — see README.md", ...result };
  writeFileSync(new URL("expected.json", here), JSON.stringify(doc, null, 2) + "\n");
}
console.log(JSON.stringify(result));