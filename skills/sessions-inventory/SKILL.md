---
name: sessions-inventory
description: List Claude Code sessions across all projects with duration, models, token totals, and billing scheme (first-party Anthropic vs router vs no cache). Use when the user asks which sessions exist, which ran longest or used the most tokens, or wants an overview table of sessions.
allowed-tools: Bash(pnpm analyze:sessions:*)
---

# Sessions inventory

Runs the inventory CLI from a claude-devtools checkout (plugin root = repo root). If `pnpm analyze:sessions` fails with "no such script", cd to this plugin's checkout first and run `pnpm install` once.

## Filters

- `--project <dir|encoded>` — one project (plain path or encoded dir name); omit for all projects
- `--min-minutes N` — only sessions running at least N minutes
- `--sort duration|tokens|date` (default duration) and `--limit N`
- `--since/--until YYYY-MM-DD` or `--last N` — by last-activity date
- `--breakdown` — per-session model token split (models column shows shares)
- `--json` — machine-readable (`tokensByModel` only appears with `--breakdown`)
- `--no-cost` accepted for grammar parity; the inventory has no cost figures

## Presenting

Render the table as printed: duration, date, file (first 8 chars of the session id), project, models, tokens, msgs, billing. Sort by duration unless the user asks otherwise; reach for `--min-minutes` to cut the noise instead of filtering the table by hand.

Billing scheme column: `anthropic-style` = cache writes seen (first-party Anthropic API), `router-style` = cache reads only, no writes (proxy/router), `mixed` = both, `no-cache` = neither. Point it out when the user wonders why some sessions cost differently than others.
