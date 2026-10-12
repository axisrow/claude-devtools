---
name: sessions-inventory
description: List Claude Code sessions across all projects with duration, models, token totals, and billing scheme (first-party Anthropic vs router vs no cache). Use when the user asks which sessions exist, which ran longest or used the most tokens, or wants an overview table of sessions.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/dist-cli/session-inventory.js:*)
---

# Sessions inventory

Runs the inventory CLI bundled with this plugin — `${CLAUDE_PLUGIN_ROOT}/dist-cli/session-inventory.js`. The binary is self-contained (executable, no install or build step needed); call it directly by that path, shown in full in the examples so the skill's own allowed-tools rule matches.

## Filters

- `--project <dir|encoded>` — one project (plain path or encoded dir name); omit for all projects
- `--min-minutes N` — only sessions running at least N minutes
- `--min-turn-minutes N` — only sessions whose longest turn ran at least N active minutes
- `--min-streak N` — only sessions where some back-to-back cycle ran at least N times (floor 4 — shorter runs are not recorded)
- `--sort duration|tokens|date` (default duration) and `--limit N`
- `--since/--until YYYY-MM-DD` or `--last N` — by last-activity date
- `--breakdown` — per-session model token split (models column shows shares)
- `--json` — machine-readable (`tokensByModel` only appears with `--breakdown`)
- `--no-cost` accepted for grammar parity; the inventory has no cost figures

## Presenting

Render the table as printed: duration, date, file (first 8 chars of the session id), project, models, tokens, msgs, billing. Sort by duration unless the user asks otherwise; reach for `--min-minutes` to cut the noise instead of filtering the table by hand.

Billing scheme column: `anthropic-style` = cache writes seen (first-party Anthropic API), `router-style` = cache reads only, no writes (proxy/router), `mixed` = both, `no-cache` = neither. Point it out when the user wonders why some sessions cost differently than others.
