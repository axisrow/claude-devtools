#!/usr/bin/env node
import { g as getProjectsBasePath, resolveProjectDir, f as formatTokensCompact, pad, padL, a as inputSideTokens, short, dur, c as createRequestLedger } from "./session-audit.js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { i as isDirectRun, w as wantsHelp, t as takeFlagValue } from "./args.js";
import { mapWithConcurrency } from "./session-inventory.js";
import { listSessionFiles } from "./tool-stats.js";
import "os";
import "crypto";
import "url";
async function scanSubagentFile(filePath, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const activeMs = opts.activeMs ?? 10 * 6e4;
  const side = createRequestLedger();
  const out = createRequestLedger();
  let lines = 0;
  let firstTsMs = null;
  let lastTsMs = null;
  let parentSessionId = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    lines++;
    if (parentSessionId === null && typeof e.sessionId === "string") {
      parentSessionId = e.sessionId;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (firstTsMs === null || ts < firstTsMs) firstTsMs = ts;
      if (lastTsMs === null || ts > lastTsMs) lastTsMs = ts;
    }
    if (e.type === "assistant" && e.message?.usage) {
      const sideAmt = inputSideTokens(e.message.usage);
      const outAmt = e.message.usage.output_tokens ?? 0;
      side.bill(e, sideAmt, true);
      out.bill(e, outAmt, true);
    }
  }
  const ongoing = lastTsMs !== null && nowMs - lastTsMs <= activeMs;
  return {
    rounds: side.keys,
    inputSide: side.spent,
    output: out.spent,
    firstTsMs,
    lastTsMs,
    lines,
    parentSessionId,
    ongoing
  };
}
async function collectSubagentRuns(projectsRoot, opts = {}) {
  let dirs;
  if (opts.projectArg) {
    dirs = [opts.projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const groups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const jobs = [];
  for (const g of groups) {
    if (!g) continue;
    for (const f of g.subagentFiles) {
      jobs.push({
        file: f,
        project: path.relative(projectsRoot, f).split(path.sep)[0] ?? "?"
      });
    }
  }
  const pairs = await mapWithConcurrency(jobs, 8, async (j) => ({
    j,
    s: await scanSubagentFile(j.file, opts)
  }));
  const rows = [];
  for (const p of pairs) {
    if (!p?.s) continue;
    const { j, s } = p;
    const base = path.basename(j.file, ".jsonl");
    const parts = j.file.split(path.sep);
    const parentFromPath = parts.length >= 3 && parts[parts.length - 2] === "subagents" ? parts[parts.length - 3] : null;
    rows.push({
      project: j.project,
      parent: parentFromPath ?? s.parentSessionId ?? "?",
      agent: base,
      filePath: j.file,
      minutes: s.firstTsMs !== null && s.lastTsMs !== null ? Math.round((s.lastTsMs - s.firstTsMs) / 6e4) : 0,
      rounds: s.rounds,
      inputSide: s.inputSide,
      output: s.output,
      firstTsMs: s.firstTsMs,
      lastTsMs: s.lastTsMs,
      ongoing: s.ongoing,
      lines: s.lines
    });
  }
  return { rows, scannedFiles: jobs.length };
}
const byMinutes = (a, b) => b.minutes - a.minutes || b.inputSide + b.output - (a.inputSide + a.output);
const byBurn = (a, b) => b.inputSide + b.output - (a.inputSide + a.output) || b.minutes - a.minutes;
function printHuman(rows, opts, root, scanned) {
  const spinning = rows.filter((r) => r.ongoing);
  console.log(`subagent-scan  active>=${opts.activeMinutes}m=NOW  corpus: ${root}`);
  console.log(
    `scanned ${scanned} subagent files · spinning now: ${spinning.length} · Σ rounds ${rows.reduce((s, r) => s + r.rounds, 0)} · Σ in ${formatTokensCompact(rows.reduce((s, r) => s + r.inputSide, 0))} · Σ out ${formatTokensCompact(rows.reduce((s, r) => s + r.output, 0))}`
  );
  if (rows.length === 0) return;
  const header = `${pad("PROJECT", 26)}${pad("SESSION", 10)}${pad("AGENT", 22)}${padL("SPAN", 9)}${padL("ROUNDS", 7)}${padL("IN", 10)}${padL("OUT", 10)}  NOW`;
  const rowLine = (r) => [
    pad(short(r.project, 24), 26),
    pad(short(r.parent, 8), 10),
    pad(short(r.agent, 20), 22),
    padL(dur(r.minutes * 6e4), 9),
    padL(String(r.rounds), 7),
    padL(r.inputSide > 0 ? formatTokensCompact(r.inputSide) : "—", 10),
    padL(r.output > 0 ? formatTokensCompact(r.output) : "—", 10),
    r.ongoing ? "  ←NOW" : ""
  ].join("");
  console.log("");
  console.log(`top by span (of ${rows.length}):`);
  console.log(header);
  for (const r of [...rows].sort(byMinutes).slice(0, opts.top)) console.log(rowLine(r));
  console.log("");
  console.log(`top by burn (in+out):`);
  console.log(header);
  for (const r of [...rows].sort(byBurn).slice(0, opts.top)) console.log(rowLine(r));
  const ladder = (title, xs, steps) => {
    const cells = steps.map((t) => `>${t} ${xs.filter((x) => x > t).length}`);
    console.log(`${title}: ${cells.join(" | ")}`);
  };
  console.log("");
  ladder(
    "span ladder (files)",
    rows.map((r) => r.minutes),
    [10, 30, 60, 120]
  );
  ladder(
    "burn ladder (in+out, Mtok)",
    rows.map((r) => (r.inputSide + r.output) / 1e6),
    [1, 5, 10, 50]
  );
}
const USAGE = `subagent-scan — per-subagent transcript accounting over ~/.claude/projects
Flags:
  --project <dir|encoded>  scan one project instead of all
  --top N                  rows per table (default 20)
  --active-minutes N       "NOW" window for still-growing files (default 10)
  --json                   machine-readable output`;
function parseSubagentScanArgs(argv) {
  const opts = { top: 20, activeMinutes: 10, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === "--project") {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === "--top") {
      const n = parseInt(value, 10);
      opts.top = n > 0 ? n : 20;
      i = next;
      continue;
    }
    if (a === "--active-minutes") {
      if (/^[1-9]\d*$/.test(value)) {
        opts.activeMinutes = parseInt(value, 10);
      } else {
        opts.error = `--active-minutes expects minutes >= 1, got '${value || "(missing)"}'`;
      }
      i = next;
      continue;
    }
    if (a === "--json") {
      opts.json = true;
      i += 1;
      continue;
    }
    if (!opts.error) opts.error = `unknown flag: '${a}' (see --help)`;
    i += 1;
  }
  return opts;
}
async function main() {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return;
  }
  const opts = parseSubagentScanArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  const root = getProjectsBasePath();
  const projectArg = opts.projectArg ? resolveProjectDir(opts.projectArg) : void 0;
  const { rows, scannedFiles } = await collectSubagentRuns(root, {
    projectArg,
    activeMs: opts.activeMinutes * 6e4
  });
  if (opts.json) {
    console.log(JSON.stringify({ root, scannedFiles, rows }, null, 2));
    return;
  }
  printHuman(rows, opts, root, scannedFiles);
}
if (isDirectRun(import.meta.url))
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
export {
  collectSubagentRuns,
  parseSubagentScanArgs,
  scanSubagentFile
};
