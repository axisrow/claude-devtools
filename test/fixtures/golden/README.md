# Golden real-session fixture (#74)

Real Claude Code session data, anonymized; validates that the app, the CLI and
the turn-budget hook reproduce independently-derived token/cost totals on data
that is not hand-written. `test/shared/goldenSession.test.ts` is the consumer.

## Files

| File | Role |
|---|---|
| `session.jsonl` | Anonymized real session (387 lines) |
| `reference.mjs` | Independent billing reference, zero imports from `src/` |
| `expected.json` | Frozen reference output with provenance; reviewed by hand on refresh |

## Provenance

Source: a real orchestration session of this project (AO worker managing PR
follow-up), plus one subagent transcript file from a separate session, spliced
in to exercise sidechain accounting the way `~/.claude/projects/` actually
organizes it. Kept windows (line ranges of the original transcript):
`[0, 260)`, `[1260, 1610)`, `[1622, 1685)` of the main session, plus the
subagent file; timestamps re-based to `2026-01-01T00:00:00.000Z` with original
inter-line deltas preserved.

Anonymization is deny-by-default: every string and every identifier field was
replaced with `[anonymized]` unless whitelisted (structural prefixes like
`<system-reminder>`, `<command-name>`, model names, message roles/types);
`uuid`, `requestId`, `message.id`, tool-use ids and parent/child links were
remapped to sequential synthetic ids so dedup and grouping structure survives.
Token `usage` numbers are untouched — that is the data under test.

Exhibited phenomena (pinned in `expected.json.fixture`): 6 models including
`<synthetic>` and an unpriced router alias (`deepseek-v4-flash:0731`), 79
streaming fragment groups, 1 compaction, 17 sidechain lines, 107 rounds with
1h cache writes.

## Reference prices

Hand-copied 2026-10-12 (do not trust blindly on refresh — re-check the pages):
sonnet-5 `2/10/0.2/2.5/4`, opus-5 `5/25/0.5/6.25/10` USD/MTok
(input/output/cache-read/cache-write-5m/cache-write-1h) from the Anthropic
pricing page; GLM rows `0.075/0.25/0.015/0.075/0.075` as priced in
`src/shared/utils/pricing.ts` (z.ai / OpenRouter snapshot). The unpriced
`deepseek-v4-flash:0731` router alias is excluded from cost and flags
`costPartial`.

## Refresh

```bash
node test/fixtures/golden/reference.mjs --write
```

re-derives `expected.json` from `session.jsonl`. Review the diff by hand: the
pin is the guardrail, silently re-pinning it defeats the test. To build a new
fixture, anonymize a real transcript with the same deny-by-default pass, then
`--write` and re-verify the phenomena minimums asserted in the test.
