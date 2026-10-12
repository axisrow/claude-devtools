---
name: audit-session
description: Audit one Claude Code session JSONL for token waste — per-turn context growth, cache reread share, duplicate/failed/oversized tool calls, context spikes, dead prompt cache, thinking-heavy turns, slow subagents, and loop diagnostics (no-op loops, stalled rounds, wait-loops, repeating cycles with no progress). Use when the user asks to audit a session, find wasted tokens or cost, or asks where a session's tokens went.
allowed-tools: Bash(pnpm analyze:session:*)
---

# Session audit

Runs the token-audit CLI from a claude-devtools checkout (plugin root = repo root). If `pnpm analyze:session` fails with "no such script", cd to this plugin's checkout first and run `pnpm install` once. Those two steps are outside the `allowed-tools` prefix, so a permission prompt there is expected — approve it, it is not a failure.

## Pick the session

- Newest session of a project: `pnpm analyze:session --project <dir> --last` — `<dir>` is the plain filesystem path of the project (e.g. `~/Projects/foo`) or its encoded dir name (`-Users-name-Projects-foo`). `--project` always requires `--last`.
- Explicit file: `pnpm analyze:session <path-to.jsonl>`.
- Narrow the window: `--since/--until YYYY-MM-DD` or `--last N` (last N calendar days).

Other flags: `--breakdown` (per-model table), `--min-severity medium|high`, `--subagent-min-minutes N` (default 5), `--rounds N` (rounds table length, default 20), `--no-cost`, `--json`.

Deep-dive one turn: `--turn N` — prints the turn's user prompt, wall/active span and round count, a verdict («цикл или длинный ход»), the turn's findings, and its last rounds.

## Read the ledger

- TOKENS: `cache_read (reread)` is the whole context re-billed every round; `reread share` near 100% is normal for long sessions — the lever is shorter turns and subagents, not the cache.
- BY TURN: growing `context` column = parent context getting fat. A jump between two rounds traces to what landed between the requests — the earlier round's tool results and any injected user/meta text — not to the tools called on the later row.
- ROUNDS: `delta` of round N = what arrived after round N−1's calls (their tool results + injected user/meta text). A `context_spike` finding names the round whose calls produced the growth, and separates tool results from injected text (skill body, attachment, user message).
- `est. cost (partial …)` = some rounds are unpriced models; costs are estimates from a built-in price table, `--no-cost` for pure token counts.

## Turn verdicts (`--turn N`)

The deep-dive answers «цикл или длинный ход?» with one verdict (CLI prints Russian labels):

- **ЦИКЛ С ВРАЩЕНИЕМ (cycle-churning)** — part of the cycle stopped converging: a probe re-ran and returned the same result. The worst verdict — the turn is spending without learning.
- **ЦИКЛ С ПРОДВИЖЕНИЕМ (cycle-progressing)** — a diagnose-fix-verify cycle whose iterations answer new questions; legitimate but expensive work.
- **ДЛИННЫЙ ХОД (long-turn)** — ≥30 rounds or ≥45 active minutes of work with no repeating sequences.
- **ОБЫЧНЫЙ ХОД (normal)** — none of the above.

Churning beats progressing: same-result probes inside a cycle mean it is stuck even when the repeated sequence looks like real work.

## Findings and what to recommend

| finding | meaning | recommendation |
| --- | --- | --- |
| duplicate_call | same tool+input called repeatedly, results re-read each time | add a deny rule for the culprit command in Claude Code settings; state the result in the prompt instead of re-reading |
| failed_call | tool errored (normal user rejections excluded) | fix the invocation; repeated failures of one command → deny rule |
| oversized_output | one tool result over ~8k tok | narrower flags on the command; write to a file and Read slices |
| context_spike | context jumped +30k in one round | move that work into a subagent so the parent only sees the summary |
| cache_dead | whole context billed as fresh input (no cache reads/writes) | check the provider/router setup — first-party Anthropic API should never look like this |
| thinking_heavy | >8k estimated thinking tok in one turn — the estimate measures returned thinking text, not billed thinking tokens (open issue #83) | split the long turn, scope the task tighter |
| long_turn | observation, not waste: the turn ran ≥45 active minutes (tokensWasted is 0; the summary names the top tools) | usually fine — scope or split the task only when the turn also churns |
| loop_streak | the same call back-to-back ×4+ — a no-op loop (e.g. `Bash true` ×N) or an env loop hammering the same failure | no-op → deny rule for the command; env loop → fix the failing setup, not the command |
| stall_streak | rounds that make tool calls yet stop growing the context (echo-marker polling the repeat-key walk cannot see) ×4+ | the turn is spinning without progress — stop and change the approach |
| wait_loop | 5+ quiet rounds with no tool calls (≤300 output tok each) re-reading the whole context — polling while waiting | poll less often, move the wait into a subagent, or end the turn and resume later |
| cycle_motif | a sequence of 3–5 rounds repeated 3+ times (diagnose-fix-verify churn) | look at probe_no_progress in the same turn: present → churning, change the approach; absent → legitimate work, consider a subagent for the loop |
| probe_no_progress | a non-mutating probe re-run with the same result signature — the loop re-asked its question and learned nothing | change the approach: state is not moving |
| !SLOW (SUBAGENTS table) | subagent ran past the threshold | split its prompt; pass less context in |

Finish with the numbers: total billed tokens, reread share, top findings by wasted tokens, and a concrete fix for each. The CLI observes, it does not prevent — prevention is deny rules in Claude Code settings.
