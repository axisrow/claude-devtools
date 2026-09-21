---
name: audit-session
description: Audit one Claude Code session JSONL for token waste — per-turn context growth, cache reread share, duplicate/failed/oversized tool calls, context spikes, dead prompt cache, thinking-heavy turns, slow subagents. Use when the user asks to audit a session, find wasted tokens or cost, or asks where a session's tokens went.
allowed-tools: Bash(pnpm analyze:session:*)
---

# Session audit

Runs the token-audit CLI from a claude-devtools checkout (plugin root = repo root). If `pnpm analyze:session` fails with "no such script", cd to this plugin's checkout first and run `pnpm install` once. Those two steps are outside the `allowed-tools` prefix, so a permission prompt there is expected — approve it, it is not a failure.

## Pick the session

- Newest session of a project: `pnpm analyze:session --project <dir> --last` — `<dir>` is the plain filesystem path of the project (e.g. `~/Projects/foo`) or its encoded dir name (`-Users-name-Projects-foo`). `--project` always requires `--last`.
- Explicit file: `pnpm analyze:session <path-to.jsonl>`.
- Narrow the window: `--since/--until YYYY-MM-DD` or `--last N` (last N calendar days).

Other flags: `--breakdown` (per-model table), `--min-severity medium|high`, `--subagent-min-minutes N` (default 5), `--rounds N` (rounds table length, default 20), `--no-cost`, `--json`.

## Read the ledger

- TOKENS: `cache_read (reread)` is the whole context re-billed every round; `reread share` near 100% is normal for long sessions — the lever is shorter turns and subagents, not the cache.
- BY TURN: growing `context` column = parent context getting fat; jumps usually trace to the tools listed on that row.
- ROUNDS: `delta` is per-round context change; `+30k` in one round means one big tool result landed in context.
- `est. cost (partial …)` = some rounds are unpriced models; costs are estimates from a built-in price table, `--no-cost` for pure token counts.

## Findings and what to recommend

| finding | meaning | recommendation |
| --- | --- | --- |
| duplicate_call | same tool+input called repeatedly, results re-read each time | add a deny rule for the culprit command in Claude Code settings; state the result in the prompt instead of re-reading |
| failed_call | tool errored (normal user rejections excluded) | fix the invocation; repeated failures of one command → deny rule |
| oversized_output | one tool result over ~8k tok | narrower flags on the command; write to a file and Read slices |
| context_spike | context jumped +30k in one round | move that work into a subagent so the parent only sees the summary |
| cache_dead | whole context billed as fresh input (no cache reads/writes) | check the provider/router setup — first-party Anthropic API should never look like this |
| thinking_heavy | >8k estimated thinking tok in one turn | split the long turn, scope the task tighter |
| !SLOW (SUBAGENTS table) | subagent ran past the threshold | split its prompt; pass less context in |

Finish with the numbers: total billed tokens, reread share, top findings by wasted tokens, and a concrete fix for each. The CLI observes, it does not prevent — prevention is deny rules in Claude Code settings.
