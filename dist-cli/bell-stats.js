#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { i as isDirectRun, w as wantsHelp, t as takeFlagValue, p as parseDayBound, a as inDateRange } from "./args.js";
import "url";
function parseTurnbudgetLogLine(line) {
  const m = /^(\S+) kind=(deny|crane) /.exec(line);
  if (!m) return null;
  const timestamp = Date.parse(m[1]);
  if (!Number.isFinite(timestamp)) return null;
  return { timestamp, source: m[2] === "crane" ? "turn_budget_crane" : "turn_budget_hook" };
}
function localDateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function buildBellStats(entries, opts = {}) {
  const counts = /* @__PURE__ */ new Map();
  let total = 0;
  for (const e of entries) {
    if (opts.type !== void 0 && e.source !== opts.type) continue;
    const d = new Date(e.timestamp);
    if (!inDateRange(d, opts.since, opts.until)) continue;
    const date = localDateKey(e.timestamp);
    const bySource = counts.get(date) ?? /* @__PURE__ */ new Map();
    bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    counts.set(date, bySource);
    total++;
  }
  const rows = [];
  for (const date of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    for (const [source, count] of [...counts.get(date).entries()].sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      rows.push({ date, source, count });
    }
  }
  return { rows, total };
}
const NOTIFICATIONS_PATH = path.join(os.homedir(), ".claude", "claude-devtools-notifications.json");
const TURNBUDGET_LOG_PATH = path.join(os.homedir(), ".claude", "claude-devtools-turnbudget.log");
function readBellEntries() {
  const out = [];
  try {
    const raw = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, "utf8"));
    if (Array.isArray(raw)) {
      for (const n of raw) {
        const timestamp = Number(n.timestamp);
        const source = n.source;
        if (Number.isFinite(timestamp) && typeof source === "string") {
          out.push({ timestamp, source });
        }
      }
    }
  } catch {
  }
  try {
    for (const line of fs.readFileSync(TURNBUDGET_LOG_PATH, "utf8").split("\n")) {
      const e = parseTurnbudgetLogLine(line);
      if (e) out.push(e);
    }
  } catch {
  }
  return out;
}
function parseDateFlag(argv, flag, endOfDay) {
  const i = argv.indexOf(flag);
  if (i === -1) return void 0;
  const { value } = takeFlagValue(argv, i);
  const d = parseDayBound(value, endOfDay);
  if (!d) {
    console.error(`bad ${flag} value: ${value} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  return d;
}
function printTable(stats, sources) {
  const cols = ["date", ...sources, "total"];
  const cells = [];
  const byDate = /* @__PURE__ */ new Map();
  for (const r of stats.rows) {
    const m = byDate.get(r.date) ?? /* @__PURE__ */ new Map();
    m.set(r.source, r.count);
    byDate.set(r.date, m);
  }
  for (const [date, m] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const row = sources.map((s) => String(m.get(s) ?? 0));
    row.push(String(row.reduce((sum, v) => sum + Number(v), 0)));
    cells.push([date, ...row]);
  }
  const width = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]?.length ?? 0)));
  const line = (vals) => vals.map((v, i) => v.padEnd(width[i])).join("  ");
  console.log(line(cols));
  for (const row of cells) console.log(line(row));
  console.log(line(["total", ...sources.map(() => ""), String(stats.total)]));
}
async function main() {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(
      "Usage: bell-stats [--type SOURCE] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]\nSources: live bell (notifications.json) + hook history (turnbudget.log\nas `turn_budget_hook` / `turn_budget_crane`). Pass --type to filter one source."
    );
    return;
  }
  const typeIdx = argv.indexOf("--type");
  const type = typeIdx === -1 ? void 0 : takeFlagValue(argv, typeIdx).value || void 0;
  const since = parseDateFlag(argv, "--since", false);
  const until = parseDateFlag(argv, "--until", true);
  const stats = buildBellStats(readBellEntries(), { type, since, until });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  const sources = [...new Set(stats.rows.map((r) => r.source))].sort((a, b) => a.localeCompare(b));
  if (stats.total === 0) {
    console.log("no bell firings in range");
    return;
  }
  printTable(stats, sources);
}
if (isDirectRun(import.meta.url)) {
  void main();
}
export {
  buildBellStats,
  parseTurnbudgetLogLine
};
