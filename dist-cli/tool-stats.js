#!/usr/bin/env node
import { resolveProjectDir, g as getProjectsBasePath, f as formatTokensCompact, pad, padL, short, d as decodePath, n as normalizeDriveLetter, t as translateWslMountPath, e as estimateContentTokens, a as extractSessionId } from "./session-audit.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { i as isDirectRun, w as wantsHelp, l as lastDaysSince, a as inDateRange, t as takeFlagValue, p as parseDayBound } from "./args.js";
import { mapWithConcurrency } from "./session-inventory.js";
import "crypto";
import "url";
const MIN_SESSIONS_FOR_OUTLIERS = 5;
const MAX_OUTLIERS = 100;
const API_ERROR_PREFIX = "API Error";
function emptyToolStat() {
  return { calls: 0, results: 0, errors: 0, orphanCalls: 0, resultTokens: 0, durationMs: 0 };
}
function sumToolStat(a, b) {
  return {
    calls: a.calls + b.calls,
    results: a.results + b.results,
    errors: a.errors + b.errors,
    orphanCalls: a.orphanCalls + b.orphanCalls,
    resultTokens: a.resultTokens + b.resultTokens,
    durationMs: a.durationMs + b.durationMs
  };
}
function percentiles(samples) {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => {
    const pos = p / 100 * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return { p5: q(5), p50: q(50), p95: q(95) };
}
const EXIT_CODE_RE = /Exit code:?\s*(\d+)/i;
function parseExitCode(toolUseResult, content) {
  if (toolUseResult && typeof toolUseResult === "object" && !Array.isArray(toolUseResult)) {
    const v = toolUseResult.exitCode;
    if (typeof v === "number") return String(v);
  }
  const m = EXIT_CODE_RE.exec(resultText(content));
  return m ? m[1] : null;
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(
      (b) => b && typeof b === "object" && typeof b.text === "string" ? b.text : ""
    ).join("\n");
  }
  return "";
}
function parseApiErrorKey(text) {
  const t = text.trim();
  if (!t.startsWith(API_ERROR_PREFIX)) return null;
  return t.slice(API_ERROR_PREFIX.length).replace(/^:\s*/, "").trim().slice(0, 120);
}
const emptyAcc = () => ({ ...emptyToolStat(), durationsMs: [] });
async function scanSessionToolStats(filePath, minCallTs) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const rel = path.relative(getProjectsBasePath(), path.resolve(filePath));
  const [projectDir = "", sessionFile = ""] = rel.split(path.sep);
  const mainTools = /* @__PURE__ */ new Map();
  const subagent = /* @__PURE__ */ new Map();
  const taskByType = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const bashExitCodes = {};
  const apiErrors = { count: 0, byText: {} };
  const toolDurationsMs = {};
  const seenCallIds = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  let cwd;
  let firstTs = null;
  let lastTs = null;
  const accFor = (map, key) => {
    let a = map.get(key);
    if (!a) {
      a = emptyAcc();
      map.set(key, a);
    }
    return a;
  };
  for await (const line of rl) {
    if (line === "") continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.timestamp) continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
    if (!cwd && e.cwd) cwd = normalizeDriveLetter(translateWslMountPath(e.cwd));
    if (minCallTs !== void 0 && ts < minCallTs) continue;
    const content = e.message?.content;
    if (e.type === "assistant" && Array.isArray(content)) {
      if (e.message?.model === "<synthetic>") {
        const key = parseApiErrorKey(resultText(content));
        if (key !== null) {
          apiErrors.count += 1;
          apiErrors.byText[key] = (apiErrors.byText[key] ?? 0) + 1;
        }
        continue;
      }
      const sub = e.isSidechain === true;
      const day = ymd(new Date(ts));
      for (const block of content) {
        const b = block;
        if (b?.type !== "tool_use" || !b.id || !b.name) continue;
        if (seenCallIds.has(b.id)) continue;
        seenCallIds.add(b.id);
        accFor(sub ? subagent : mainTools, b.name).calls += 1;
        if (!sub) {
          const dayMap = byDay.get(day) ?? /* @__PURE__ */ new Map();
          byDay.set(day, dayMap);
          dayMap.set(b.name, (dayMap.get(b.name) ?? 0) + 1);
        }
        let taskType;
        if (b.name === "Task" && !sub) {
          const rawType = b.input ?? {};
          const rawSubagentType = rawType.subagent_type;
          taskType = typeof rawSubagentType === "string" && rawSubagentType !== "" ? rawSubagentType : "unknown";
          accFor(taskByType, taskType).calls += 1;
        }
        pending.set(b.id, { name: b.name, sub, ts, taskType });
      }
    } else if (e.type === "user" && Array.isArray(content)) {
      const tur = e.toolUseResult;
      for (const block of content) {
        const b = block;
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        const tokens = estimateContentTokens(b.content ?? "");
        const delta = Math.max(ts - call.ts, 0);
        const acc = accFor(call.sub ? subagent : mainTools, call.name);
        acc.results += 1;
        if (b.is_error === true) acc.errors += 1;
        acc.durationMs += delta;
        acc.resultTokens += tokens;
        if (toolDurationsMs[call.name]) toolDurationsMs[call.name].push(delta);
        else toolDurationsMs[call.name] = [delta];
        if (call.taskType !== void 0) {
          const t = accFor(taskByType, call.taskType);
          t.results += 1;
          if (b.is_error === true) t.errors += 1;
          t.durationMs += delta;
          t.resultTokens += tokens;
        }
        if (call.name === "Bash") {
          const code = parseExitCode(tur, b.content);
          if (code !== null) bashExitCodes[code] = (bashExitCodes[code] ?? 0) + 1;
        }
      }
    }
  }
  if (firstTs === null) return null;
  for (const call of pending.values()) {
    accFor(call.sub ? subagent : mainTools, call.name).orphanCalls += 1;
    if (call.taskType !== void 0) accFor(taskByType, call.taskType).orphanCalls += 1;
  }
  return {
    projectId: projectDir,
    sessionId: extractSessionId(sessionFile),
    cwd,
    lastTs: lastTs !== null ? new Date(lastTs) : null,
    main: Object.fromEntries(mainTools),
    subagent: Object.fromEntries(subagent),
    taskByType: Object.fromEntries(taskByType),
    byDay: Object.fromEntries([...byDay].map(([d, m]) => [d, Object.fromEntries(m)])),
    bashExitCodes,
    apiErrors,
    toolDurationsMs
  };
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const accForProjectTool = (m, tool) => {
  let a = m.get(tool);
  if (!a) {
    a = { stat: emptyToolStat(), sessions: 0, apiErrors: 0 };
    m.set(tool, a);
  }
  return a;
};
function aggregate(sessions) {
  const byTool = /* @__PURE__ */ new Map();
  const byProject = /* @__PURE__ */ new Map();
  const projectCwd = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const taskByType = /* @__PURE__ */ new Map();
  const bashExitCodes = {};
  const apiErrors = { count: 0, byText: {} };
  const callsSamples = /* @__PURE__ */ new Map();
  const errorsSamples = /* @__PURE__ */ new Map();
  const resultTokSamples = /* @__PURE__ */ new Map();
  const durSumSamples = /* @__PURE__ */ new Map();
  const apiErrSamples = /* @__PURE__ */ new Map();
  const pooledDurations = /* @__PURE__ */ new Map();
  const projectTool = /* @__PURE__ */ new Map();
  const sample = (m, tool, v) => {
    if (m.has(tool)) m.get(tool).push(v);
    else m.set(tool, [v]);
  };
  for (const s of sessions) {
    const proj = byProject.get(s.projectId) ?? {
      sessions: 0,
      calls: 0,
      errors: 0,
      resultTokens: 0
    };
    if (!byProject.has(s.projectId)) byProject.set(s.projectId, proj);
    proj.sessions += 1;
    if (s.cwd && !projectCwd.has(s.projectId)) projectCwd.set(s.projectId, s.cwd);
    const perTool = projectTool.get(s.projectId) ?? /* @__PURE__ */ new Map();
    projectTool.set(s.projectId, perTool);
    const toolsThisSession = /* @__PURE__ */ new Set();
    for (const map of [s.main, s.subagent]) {
      for (const [tool, stat] of Object.entries(map)) {
        toolsThisSession.add(tool);
        byTool.set(tool, sumToolStat(byTool.get(tool) ?? emptyToolStat(), stat));
        proj.calls += stat.calls;
        proj.errors += stat.errors;
        proj.resultTokens += stat.resultTokens;
        const acc = accForProjectTool(perTool, tool);
        acc.stat = sumToolStat(acc.stat, stat);
      }
    }
    for (const tool of toolsThisSession) {
      const acc = accForProjectTool(perTool, tool);
      acc.sessions += 1;
      acc.apiErrors += s.apiErrors.count;
      const merged = mergeToolStat(s, tool);
      sample(callsSamples, tool, merged.calls);
      sample(errorsSamples, tool, merged.errors);
      sample(resultTokSamples, tool, merged.resultTokens);
      sample(durSumSamples, tool, merged.durationMs);
      sample(apiErrSamples, tool, s.apiErrors.count);
    }
    for (const [day, tools] of Object.entries(s.byDay)) {
      const dayMap = byDay.get(day) ?? /* @__PURE__ */ new Map();
      byDay.set(day, dayMap);
      for (const [tool, n] of Object.entries(tools)) {
        dayMap.set(tool, (dayMap.get(tool) ?? 0) + n);
      }
    }
    for (const [type, stat] of Object.entries(s.taskByType)) {
      taskByType.set(type, sumToolStat(taskByType.get(type) ?? emptyToolStat(), stat));
    }
    for (const [code, n] of Object.entries(s.bashExitCodes)) {
      bashExitCodes[code] = (bashExitCodes[code] ?? 0) + n;
    }
    apiErrors.count += s.apiErrors.count;
    for (const [key, n] of Object.entries(s.apiErrors.byText)) {
      apiErrors.byText[key] = (apiErrors.byText[key] ?? 0) + n;
    }
    for (const [tool, durations] of Object.entries(s.toolDurationsMs)) {
      if (pooledDurations.has(tool)) pooledDurations.get(tool).push(...durations);
      else pooledDurations.set(tool, [...durations]);
    }
  }
  for (const [projectId, cwdPath] of projectCwd) {
    const proj = byProject.get(projectId);
    if (proj) proj.name = shortenHome(cwdPath);
  }
  const bands = {};
  for (const [tool, calls] of callsSamples) {
    if (calls.length < MIN_SESSIONS_FOR_OUTLIERS) continue;
    const p = (m) => percentiles(m.get(tool) ?? []);
    bands[tool] = {
      callsPerSession: p(callsSamples),
      errorsPerSession: p(errorsSamples),
      resultTokensPerSession: p(resultTokSamples),
      durationPerSessionMs: p(durSumSamples),
      durationPerCallMs: p(pooledDurations),
      apiErrorsPerSession: p(apiErrSamples)
    };
  }
  const outliers = [];
  const check = (scope, projectId, sessionId, tool, metric, value, band) => {
    if (value > band.p95 || value < band.p5) {
      outliers.push({ scope, projectId, sessionId, tool, metric, value, band });
    }
  };
  for (const s of sessions) {
    for (const tool of Object.keys(bands)) {
      if (!usedTool(s, tool)) continue;
      const band = bands[tool];
      const merged = mergeToolStat(s, tool);
      check("session", s.projectId, s.sessionId, tool, "calls", merged.calls, band.callsPerSession);
      check(
        "session",
        s.projectId,
        s.sessionId,
        tool,
        "errors",
        merged.errors,
        band.errorsPerSession
      );
      check(
        "session",
        s.projectId,
        s.sessionId,
        tool,
        "resultTokens",
        merged.resultTokens,
        band.resultTokensPerSession
      );
      check(
        "session",
        s.projectId,
        s.sessionId,
        tool,
        "durationMs",
        merged.durationMs,
        band.durationPerSessionMs
      );
      check(
        "session",
        s.projectId,
        s.sessionId,
        tool,
        "apiErrors",
        s.apiErrors.count,
        band.apiErrorsPerSession
      );
    }
  }
  for (const [projectId, perTool] of projectTool) {
    for (const [tool, acc] of perTool) {
      const band = bands[tool];
      if (!band || acc.sessions === 0) continue;
      check(
        "project",
        projectId,
        void 0,
        tool,
        "calls",
        acc.stat.calls / acc.sessions,
        band.callsPerSession
      );
      check(
        "project",
        projectId,
        void 0,
        tool,
        "errors",
        acc.stat.errors / acc.sessions,
        band.errorsPerSession
      );
      check(
        "project",
        projectId,
        void 0,
        tool,
        "resultTokens",
        acc.stat.resultTokens / acc.sessions,
        band.resultTokensPerSession
      );
      check(
        "project",
        projectId,
        void 0,
        tool,
        "durationMs",
        acc.stat.durationMs / acc.sessions,
        band.durationPerSessionMs
      );
      check(
        "project",
        projectId,
        void 0,
        tool,
        "apiErrors",
        acc.apiErrors / acc.sessions,
        band.apiErrorsPerSession
      );
    }
  }
  outliers.sort((a, b) => excess(b) - excess(a));
  outliers.length = Math.min(outliers.length, MAX_OUTLIERS);
  return {
    sessions: sessions.length,
    totalCalls: [...byTool.values()].reduce((sum, s) => sum + s.calls, 0),
    byTool: Object.fromEntries(byTool),
    byProject: Object.fromEntries(byProject),
    byDay: Object.fromEntries([...byDay].map(([d, m]) => [d, Object.fromEntries(m)])),
    taskByType: Object.fromEntries(taskByType),
    bashExitCodes,
    apiErrors,
    byToolPercentiles: bands,
    outliers
  };
}
function usedTool(s, tool) {
  return tool in s.main || tool in s.subagent;
}
function mergeToolStat(s, tool) {
  return sumToolStat(s.main[tool] ?? emptyToolStat(), s.subagent[tool] ?? emptyToolStat());
}
const excess = (o) => o.value > o.band.p95 ? (o.value - o.band.p95) / Math.max(o.band.p95, 1) : (o.band.p5 - o.value) / Math.max(o.band.p5, 1);
const shortenHome = (p) => {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};
function parseToolStatsArgs(argv) {
  const opts = {
    sort: "calls",
    limit: 20,
    byDay: false,
    sessions: false,
    json: false
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === "--project") {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === "--since" || a === "--until") {
      const d = parseDayBound(value, a === "--until");
      if (!d) opts.error = `invalid ${a} date (expected YYYY-MM-DD or YYYYMMDD): '${value}'`;
      else if (a === "--since") opts.since = d;
      else opts.until = d;
      i = next;
      continue;
    }
    if (a === "--last") {
      if (/^[1-9]\d*$/.test(value)) {
        opts.since = lastDaysSince(parseInt(value, 10));
        i = next;
      } else {
        opts.error = `--last expects a number of days >= 1, got '${value || "(missing)"}'`;
        i += 1;
      }
      continue;
    }
    if (a === "--day-window") {
      if (/^[1-9]\d*$/.test(value)) {
        opts.dayWindow = parseInt(value, 10);
        i = next;
      } else {
        opts.error = `--day-window expects a number of days >= 1, got '${value || "(missing)"}'`;
        i += 1;
      }
      continue;
    }
    if (a === "--sort") {
      opts.sort = value === "errors" || value === "tokens" || value === "name" ? value : "calls";
      i = next;
      continue;
    }
    if (a === "--limit") {
      const n = parseInt(value, 10);
      opts.limit = n > 0 ? n : 20;
      i = next;
      continue;
    }
    if (a === "--by-day") {
      opts.byDay = true;
      i += 1;
      continue;
    }
    if (a === "--sessions") {
      opts.sessions = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      opts.json = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return opts;
}
async function listSessionFiles(projectDir) {
  const out = [];
  for (const e of await fs.promises.readdir(projectDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("agent-")) {
      out.push(path.join(projectDir, e.name));
    }
  }
  return out;
}
async function collect(projectsRoot, projectArg, minCallTs) {
  let dirs;
  if (projectArg) {
    dirs = [projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const fileGroups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const files = fileGroups.filter((g) => g !== null).flat();
  const scanned = await mapWithConcurrency(files, 8, (f) => scanSessionToolStats(f, minCallTs));
  return scanned.filter((s) => s !== null);
}
function sortSessions(sessions, sort) {
  const total = (s) => mergeAll(s);
  return [...sessions].sort((a, b) => {
    if (sort === "errors") return total(b).errors - total(a).errors;
    if (sort === "tokens") return total(b).resultTokens - total(a).resultTokens;
    if (sort === "name") return a.projectId.localeCompare(b.projectId);
    return total(b).calls - total(a).calls;
  });
}
function mergeAll(s) {
  const all = Object.values(s.main).concat(Object.values(s.subagent));
  return all.reduce((acc, st) => sumToolStat(acc, st), emptyToolStat());
}
function fmtMs(ms) {
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  if (ms < 36e5)
    return `${Math.floor(ms / 6e4)}m${String(Math.round(ms % 6e4 / 1e3)).padStart(2, "0")}s`;
  return `${Math.round(ms / 36e5)}h`;
}
function printHuman(agg, sessions, opts) {
  const notes = [];
  if (opts.since && opts.until) notes.push(`${ymd(opts.since)}..${ymd(opts.until)}`);
  else if (opts.since) notes.push(`since ${ymd(opts.since)}`);
  else if (opts.until) notes.push(`until ${ymd(opts.until)}`);
  if (opts.dayWindow !== void 0) notes.push(`day-window: last ${opts.dayWindow} day(s)`);
  const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  const tools = Object.entries(agg.byTool);
  const sorters = {
    calls: (a, b) => b[1].calls - a[1].calls,
    errors: (a, b) => b[1].errors - a[1].errors,
    tokens: (a, b) => b[1].resultTokens - a[1].resultTokens,
    name: (a, b) => a[0].localeCompare(b[0])
  };
  const shown = tools.toSorted(sorters[opts.sort]).slice(0, opts.limit);
  const callTotal = Math.max(agg.totalCalls, 1);
  console.log(
    `tool usage — ${agg.sessions} sessions in ${Object.keys(agg.byProject).length} projects, ${formatTokensCompact(agg.totalCalls)} calls${note}`
  );
  console.log();
  console.log(
    `${pad("tool", 28)} ${padL("calls", 7)} ${padL("share", 6)} ${padL("errors", 7)} ${padL("err%", 6)} ${padL("orphan", 7)} ${padL("result-tok", 11)} ${padL("avg-ms", 8)} ${padL("p95-ms", 9)}`
  );
  for (const [tool, st] of shown) {
    const band = agg.byToolPercentiles[tool];
    const share = (st.calls / callTotal * 100).toFixed(1) + "%";
    const errPct = st.results > 0 ? (st.errors / st.results * 100).toFixed(1) + "%" : "-";
    const avgMs = st.results > 0 ? fmtMs(st.durationMs / st.results) : "-";
    const p95Ms = band ? fmtMs(band.durationPerCallMs.p95) : "-";
    console.log(
      `${pad(short(tool, 28), 28)} ${padL(String(st.calls), 7)} ${padL(share, 6)} ${padL(String(st.errors), 7)} ${padL(errPct, 6)} ${padL(String(st.orphanCalls), 7)} ${padL(formatTokensCompact(st.resultTokens), 11)} ${padL(avgMs, 8)} ${padL(p95Ms, 9)}`
    );
  }
  const codes = Object.entries(agg.bashExitCodes).sort((a, b) => b[1] - a[1]);
  if (codes.length > 0) {
    const bashResults = agg.byTool.Bash?.results ?? 0;
    const nonZero = codes.filter(([c]) => c !== "0").reduce((s, [, n]) => s + n, 0);
    const rate = bashResults > 0 ? ` (non-zero ${(nonZero / bashResults * 100).toFixed(1)}%)` : "";
    console.log();
    console.log(
      `bash exit codes:${rate} ${codes.slice(0, 8).map(([c, n]) => `${c}=${formatTokensCompact(n)}`).join("  ")}`
    );
  }
  if (agg.apiErrors.count > 0) {
    const top = Object.entries(agg.apiErrors.byText).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `"${short(t, 60)}" ${formatTokensCompact(n)}`).join(", ");
    console.log();
    console.log(
      `api errors: ${formatTokensCompact(agg.apiErrors.count)} (${(agg.apiErrors.count / Math.max(agg.sessions, 1)).toFixed(2)}/sess) — top: ${top}`
    );
  }
  const taskTypes = Object.entries(agg.taskByType).sort((a, b) => b[1].calls - a[1].calls);
  if (taskTypes.length > 0) {
    console.log();
    console.log("task subagent types:");
    for (const [type, st] of taskTypes.slice(0, 10)) {
      console.log(
        `  ${pad(short(type, 30), 30)} ${padL(String(st.calls), 6)} calls ${padL(String(st.errors), 5)} errors ${padL(formatTokensCompact(st.resultTokens), 10)} result-tok`
      );
    }
  }
  const projects = Object.entries(agg.byProject).sort((a, b) => b[1].calls - a[1].calls).slice(0, 10);
  if (projects.length > 0) {
    console.log();
    console.log("by project (top 10 by calls):");
    console.log(
      `${pad("project", 44)} ${padL("sessions", 8)} ${padL("calls", 8)} ${padL("errors", 7)} ${padL("result-tok", 11)}`
    );
    for (const [id, p] of projects) {
      const name = p.name ?? shortenHome(decodePath(id));
      console.log(
        `${pad(short(name, 44), 44)} ${padL(String(p.sessions), 8)} ${padL(formatTokensCompact(p.calls), 8)} ${padL(String(p.errors), 7)} ${padL(formatTokensCompact(p.resultTokens), 11)}`
      );
    }
  }
  if (opts.byDay) {
    const days = Object.entries(agg.byDay).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length > 0) {
      console.log();
      console.log("by day:");
      console.log(`${pad("date", 11)} ${padL("calls", 7)}  top tools`);
      for (const [day, dayTools] of days) {
        const total = Object.values(dayTools).reduce((s, v) => s + v, 0);
        const top = Object.entries(dayTools).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} ${n}`).join(", ");
        console.log(`${pad(day, 11)} ${padL(String(total), 7)}  ${short(top, 60)}`);
      }
    }
  }
  if (agg.outliers.length > 0) {
    console.log();
    console.log(
      `outliers (outside P5–P95 per tool, tools with >= ${MIN_SESSIONS_FOR_OUTLIERS} sessions; top ${Math.min(agg.outliers.length, 20)}):`
    );
    console.log(
      `${pad("scope", 8)} ${pad("where", 34)} ${pad("tool", 20)} ${pad("metric", 13)} ${padL("value", 10)}  band p5..p95`
    );
    const projectCwd = /* @__PURE__ */ new Map();
    for (const s of sessions) {
      if (s.cwd && !projectCwd.has(s.projectId)) projectCwd.set(s.projectId, s.cwd);
    }
    for (const o of agg.outliers.slice(0, 20)) {
      const projectDir = projectCwd.get(o.projectId) ?? shortenHome(decodePath(o.projectId));
      const where = o.scope === "session" ? `${short(projectDir, 24)}/${(o.sessionId ?? "").slice(0, 8)}` : short(projectDir, 34);
      console.log(
        `${pad(o.scope, 8)} ${pad(where, 34)} ${pad(short(o.tool, 20), 20)} ${pad(o.metric, 13)} ${padL(String(Math.round(o.value)), 10)}  ${Math.round(o.band.p5)}..${Math.round(o.band.p95)}`
      );
    }
  }
  if (opts.sessions && sessions.length > 0) {
    console.log();
    console.log("sessions:");
    console.log(
      `${pad("project", 40)} ${pad("session", 9)} ${pad("date", 11)} ${padL("calls", 7)} ${padL("errors", 7)} ${padL("api-err", 7)} ${padL("result-tok", 11)}`
    );
    for (const s of sortSessions(sessions, opts.sort).slice(0, opts.limit)) {
      const merged = mergeAll(s);
      console.log(
        `${pad(short(s.cwd ? shortenHome(s.cwd) : shortenHome(decodePath(s.projectId)), 40), 40)} ${pad(s.sessionId.slice(0, 8), 9)} ${pad(s.lastTs ? ymd(s.lastTs) : "n/a", 11)} ${padL(String(merged.calls), 7)} ${padL(String(merged.errors), 7)} ${padL(String(s.apiErrors.count), 7)} ${padL(formatTokensCompact(merged.resultTokens), 11)}`
      );
    }
  }
}
async function main() {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(
      [
        "usage: tool-stats [--project <dir|encoded>] [flags]",
        "",
        "flags:",
        "  --project <dir|encoded>   scan one project instead of all",
        "  --since DATE              only sessions whose last activity is on/after this date (YYYY-MM-DD or YYYYMMDD)",
        "  --until DATE              only sessions whose last activity is on/before this date",
        "  --last N                  sessions whose last activity falls in the last N calendar days",
        "  --day-window N            call-level slice: only calls made in the last N calendar days",
        "  --sort FIELD              calls | errors | tokens | name (default calls)",
        "  --limit N                 show first N rows (default 20)",
        "  --by-day                  per-date call counts",
        "  --sessions                include per-session rows",
        "  --json                    machine-readable output"
      ].join("\n")
    );
    return;
  }
  const opts = parseToolStatsArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  let projectDir;
  if (opts.projectArg) {
    projectDir = resolveProjectDir(opts.projectArg);
    if (!fs.existsSync(projectDir)) {
      console.error(`project dir not found: ${opts.projectArg}`);
      process.exitCode = 1;
      return;
    }
  }
  const minCallTs = opts.dayWindow !== void 0 ? lastDaysSince(opts.dayWindow).getTime() : void 0;
  const scanned = await collect(getProjectsBasePath(), projectDir, minCallTs);
  const withCalls = minCallTs !== void 0 ? scanned.filter((s) => mergeAll(s).calls > 0) : scanned;
  const hasDateFilter = opts.since !== void 0 || opts.until !== void 0;
  const sessions = withCalls.filter(
    (s) => hasDateFilter ? s.lastTs !== null && inDateRange(s.lastTs, opts.since, opts.until) : true
  );
  if (sessions.length === 0) {
    console.log("no sessions found");
    return;
  }
  const agg = aggregate(sessions);
  if (opts.json) {
    const out = { ...agg };
    if (opts.sessions) {
      out.sessions = sortSessions(sessions, opts.sort).map((s) => ({
        ...s,
        toolDurationsMs: void 0
      }));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  printHuman(agg, sessions, opts);
}
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
export {
  MAX_OUTLIERS,
  MIN_SESSIONS_FOR_OUTLIERS,
  aggregate,
  emptyToolStat,
  parseApiErrorKey,
  parseExitCode,
  parseToolStatsArgs,
  percentiles,
  scanSessionToolStats,
  sumToolStat
};
