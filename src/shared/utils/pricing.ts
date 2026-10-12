/**
 * Model pricing (#72, #73) — USD per MTok with explicit columns: input /
 * output / cacheRead / cacheWrite5m / cacheWrite1h. Single source for the CLI
 * ledger (analyzeSession totalsFromRounds) and the app's session metrics
 * (jsonl.ts calculateMetrics). Hand-checked against Anthropic's published
 * prices on 2026-10-12 (https://platform.claude.com/pricing) — re-check when
 * a new generation ships. Cache WRITE is 1.25x/2x input across the board;
 * cache READ is NOT a fixed ratio (opus 5.5 = 0.05x, fable = 0.025x). Test
 * values in test/main/cli/analyzeSession.test.ts are hand-written from the
 * same price page, so a table edit cannot silently pass them.
 */

import { parseModelString } from './modelParser';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Minimal round shape needed to price it — the CLI's RoundRow and the
 * per-message usage rows in calculateMetrics both satisfy this. */
export interface PriceableRound {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** TTL split from usage.cache_creation (#72); absent → whole cacheCreationTokens prices at the 5m rate */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

// glm: public rates (OpenRouter/z.ai, verified 2026-09-21); cache write assumed = input rate
export const GLM_PRICE: ModelPrice = {
  input: 0.075,
  output: 0.25,
  cacheRead: 0.015,
  cacheWrite5m: 0.075,
  cacheWrite1h: 0.075,
};

const mkPrice = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite5m: number,
  cacheWrite1h: number
): ModelPrice => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });

// price by (family, major, minor); a future version lands on the latest known
// row of its family until priced
export function claudePriceFor(
  family: string,
  major: number,
  minor: number | null
): ModelPrice | null {
  switch (family) {
    case 'opus':
      // 5.5+ at the reduced rate; 4.5–5 at 5/25; ≤4.1 legacy at 15/75.
      // 4.x needs an explicit minor: dated ids (claude-opus-4-20250514) parse
      // with minor=null and are old-generation, not 4.5+
      if (major > 5 || (major === 5 && minor !== null && minor >= 5)) {
        return mkPrice(4, 20, 0.2, 5, 8);
      }
      if (major >= 5 || (major === 4 && minor !== null && minor >= 5)) {
        return mkPrice(5, 25, 0.5, 6.25, 10);
      }
      return mkPrice(15, 75, 1.5, 18.75, 30);
    case 'sonnet':
      // 5+ at 2/10; 4.x and older at 3/15
      return major >= 5 ? mkPrice(2, 10, 0.2, 2.5, 4) : mkPrice(3, 15, 0.3, 3.75, 6);
    case 'haiku':
      // 5.5 at 0.10/0.50 (long-prompt tier applied in priceForRound); 4.5 and older at 1/5
      return major >= 5 ? mkPrice(0.1, 0.5, 0.01, 0.125, 0.2) : mkPrice(1, 5, 0.1, 1.25, 2);
    case 'fable':
      // fable 5 / 5.1
      return major >= 5 ? mkPrice(10, 50, 0.25, 12.5, 20) : null;
    default:
      return null;
  }
}

// price of a round's model: claude via parser (version-aware), glm literal,
// everything else unpriced; null = unpriced model
export function priceForRound(r: PriceableRound): ModelPrice | null {
  const info = parseModelString(r.model);
  if (!info) {
    // non-claude: first id segment (glm-5.3-flash → glm)
    return r.model.toLowerCase().split('-')[0] === 'glm' ? GLM_PRICE : null;
  }
  const price = claudePriceFor(info.family, info.majorVersion, info.minorVersion);
  if (!price || info.family !== 'haiku' || info.majorVersion < 5) return price;
  // haiku 5.5 long-prompt tier: prompts >100K bill 0.50/2.50 in/out (cache
  // rates above 100K unpublished — base cache rates applied; ponytail)
  const prompt = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
  return prompt > 100_000 ? { ...price, input: 0.5, output: 2.5 } : price;
}

// cost of one round at the built-in price table; null = unpriced model
export function roundCostUsd(r: PriceableRound): number | null {
  const price = priceForRound(r);
  if (!price) return null;
  // without a TTL split the whole write is billed at the 5m rate
  const cw5m = r.cacheWrite5mTokens ?? r.cacheCreationTokens;
  const cw1h = r.cacheWrite1hTokens ?? 0;
  return (
    (r.inputTokens * price.input +
      r.outputTokens * price.output +
      r.cacheReadTokens * price.cacheRead +
      cw5m * price.cacheWrite5m +
      cw1h * price.cacheWrite1h) /
    1e6
  );
}
