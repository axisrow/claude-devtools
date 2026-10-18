#!/usr/bin/env node
import * as fs from "fs";
import { pathToFileURL } from "url";
function takeFlagValue(argv, i) {
  const hasArg = i + 1 < argv.length;
  const isValue = hasArg && !argv[i + 1].startsWith("--");
  return isValue ? { value: argv[i + 1], next: i + 2 } : { value: "", next: i + 1 };
}
function isDirectRun(selfUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return selfUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
const wantsHelp = (argv) => argv.includes("--help") || argv.includes("-h");
function parseDayBound(s, endOfDay) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}
function lastDaysSince(days) {
  const d = /* @__PURE__ */ new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}
function inDateRange(ts, since, until) {
  if (since && ts < since) return false;
  if (until && ts > until) return false;
  return true;
}
export {
  inDateRange as a,
  isDirectRun as i,
  lastDaysSince as l,
  parseDayBound as p,
  takeFlagValue as t,
  wantsHelp as w
};
