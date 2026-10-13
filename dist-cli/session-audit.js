#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as crypto from "crypto";
import { pathToFileURL } from "url";
class LocalFileSystemProvider {
  constructor() {
    this.type = "local";
  }
  async exists(filePath) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
  async readFile(filePath, encoding = "utf8") {
    return fs.promises.readFile(filePath, encoding);
  }
  async stat(filePath) {
    const stats = await fs.promises.stat(filePath);
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory()
    };
  }
  async readdir(dirPath) {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry) => {
        let mtimeMs;
        try {
          const stat = await fs.promises.stat(`${dirPath}/${entry.name}`);
          mtimeMs = stat.mtimeMs;
        } catch {
        }
        return {
          name: entry.name,
          mtimeMs,
          isFile: () => entry.isFile(),
          isDirectory: () => entry.isDirectory()
        };
      })
    );
  }
  createReadStream(filePath, opts) {
    return fs.createReadStream(filePath, {
      start: opts?.start,
      encoding: opts?.encoding
    });
  }
  dispose() {
  }
}
function encodePath(absolutePath) {
  if (!absolutePath) {
    return "";
  }
  const encoded = absolutePath.replace(/[/\\]/g, "-");
  return encoded.startsWith("-") ? encoded : `-${encoded}`;
}
function decodePath(encodedName) {
  if (!encodedName) {
    return "";
  }
  const legacyWindowsRegex = /^([a-zA-Z])--(.+)$/;
  const legacyWindowsMatch = legacyWindowsRegex.exec(encodedName);
  if (legacyWindowsMatch) {
    const drive = legacyWindowsMatch[1].toUpperCase();
    const rest = legacyWindowsMatch[2].replace(/-/g, "/");
    return `${drive}:/${rest}`;
  }
  const withoutLeadingDash = encodedName.startsWith("-") ? encodedName.slice(1) : encodedName;
  const decodedPath = withoutLeadingDash.replace(/-/g, "/");
  if (/^[a-zA-Z]:\//.test(decodedPath)) {
    return decodedPath;
  }
  const absolutePath = decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`;
  return translateWslMountPath(absolutePath);
}
function extractProjectName(encodedName, cwdHint) {
  const decoded = decodePath(encodedName);
  const segments = decoded.split("/").filter(Boolean);
  return segments[segments.length - 1] || encodedName;
}
function normalizeDriveLetter(p) {
  if (p.length >= 2 && p[1] === ":") {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}
function translateWslMountPath(posixPath) {
  if (process.platform !== "win32") {
    return posixPath;
  }
  const match = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(posixPath);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2] ?? "";
    return `${drive}:${rest}`;
  }
  return posixPath;
}
function isValidEncodedPath(encodedName) {
  if (!encodedName) {
    return false;
  }
  if (/^[a-zA-Z]--[a-zA-Z0-9_.\s-]+$/.test(encodedName)) {
    return true;
  }
  if (!encodedName.startsWith("-")) {
    return false;
  }
  const validPattern = /^-[a-zA-Z0-9_.\s:-]+$/;
  if (!validPattern.test(encodedName)) {
    return false;
  }
  const firstColon = encodedName.indexOf(":");
  if (firstColon === -1) {
    return true;
  }
  if (!/^-[a-zA-Z]:/.test(encodedName)) {
    return false;
  }
  return !encodedName.includes(":", firstColon + 1);
}
function extractBaseDir(projectId) {
  const sep = projectId.indexOf("::");
  if (sep !== -1) {
    return projectId.slice(0, sep);
  }
  return projectId;
}
function extractSessionId(filename) {
  return filename.replace(/\.jsonl$/, "");
}
function buildSessionPath(basePath, projectId, sessionId) {
  return path.join(basePath, extractBaseDir(projectId), `${sessionId}.jsonl`);
}
function buildSubagentsPath(basePath, projectId, sessionId) {
  return path.join(basePath, extractBaseDir(projectId), sessionId, "subagents");
}
function buildTodoPath(claudeBasePath, sessionId) {
  return path.join(claudeBasePath, "todos", `${sessionId}.json`);
}
function getHomeDir() {
  const windowsHome = process.env.HOMEDRIVE && process.env.HOMEPATH ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` : null;
  return process.env.HOME || process.env.USERPROFILE || windowsHome || os.homedir() || "/";
}
function getDefaultClaudeBasePath() {
  return path.join(getHomeDir(), ".claude");
}
function getClaudeBasePath() {
  return getDefaultClaudeBasePath();
}
function getProjectsBasePath() {
  return path.join(getClaudeBasePath(), "projects");
}
function getTodosBasePath() {
  return path.join(getClaudeBasePath(), "todos");
}
class Logger {
  constructor(namespace) {
    this.namespace = namespace;
  }
  static {
    this.level = (() => {
      const raw = process.env.CLAUDE_DEVTOOLS_LOG_LEVEL;
      if (raw === "debug") return 0;
      if (raw === "info") return 1;
      return process.env.NODE_ENV === "production" ? 3 : 2;
    })();
  }
  debug(...args) {
    if (Logger.level <= 0) {
      console.debug(`[${this.namespace}]`, ...args);
    }
  }
  info(...args) {
    if (Logger.level <= 1) {
      console.log(`[${this.namespace}]`, ...args);
    }
  }
  warn(...args) {
    if (Logger.level <= 2) {
      console.warn(`[${this.namespace}]`, ...args);
    }
  }
  error(...args) {
    if (Logger.level <= 3) {
      console.error(`[${this.namespace}]`, ...args);
    }
  }
  /** Allow runtime level changes (for testing/debugging) */
  static setLevel(level) {
    Logger.level = level;
  }
  static getLevel() {
    return Logger.level;
  }
}
function createLogger(namespace) {
  return new Logger(namespace);
}
const ENTRY_REGEX = /^\s*-\s*\[([^\]\n]+)\]\(([^)\n]+\.md)\)\s*(?:[—–-]\s*(.*))?$/;
function parseMemoryIndex(markdown, dirListing) {
  const entries = [];
  const seenFiles = /* @__PURE__ */ new Set();
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const match = ENTRY_REGEX.exec(line);
    if (!match) return;
    const [, title, file, hook] = match;
    if (!title || !file) return;
    entries.push({
      title: title.trim(),
      file: file.trim(),
      hook: (hook ?? "").trim(),
      lineNumber: idx + 1
    });
    seenFiles.add(file.trim());
  });
  const orphanFiles = dirListing.filter((name) => name.toLowerCase().endsWith(".md")).filter((name) => name !== "MEMORY.md" && !seenFiles.has(name)).sort((a, b) => a.localeCompare(b));
  return { rawMarkdown: markdown, entries, orphanFiles };
}
const logger$9 = createLogger("Discovery:MemoryReader");
const MEMORY_DIR_NAME = "memory";
const INDEX_FILE_NAME = "MEMORY.md";
class MemoryReader {
  constructor(projectsDir, fsProvider) {
    this.projectsDir = projectsDir ?? getProjectsBasePath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }
  getDirPath(projectId) {
    return path.join(this.projectsDir, extractBaseDir(projectId), MEMORY_DIR_NAME);
  }
  getFilePath(projectId, fileName) {
    const dir = this.getDirPath(projectId);
    const safeName = this.assertSafeMarkdownName(fileName);
    const resolved = path.resolve(dir, safeName);
    if (resolved !== path.join(dir, safeName)) {
      throw new Error(`Memory file path escapes memory directory: ${fileName}`);
    }
    return resolved;
  }
  async hasMemory(projectId) {
    const dir = this.getDirPath(projectId);
    if (!await this.fsProvider.exists(dir)) return false;
    try {
      const entries = await this.fsProvider.readdir(dir);
      return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
    } catch (error) {
      logger$9.error(`Failed to probe memory dir for ${projectId}:`, error);
      return false;
    }
  }
  async readIndex(projectId) {
    const dir = this.getDirPath(projectId);
    if (!await this.fsProvider.exists(dir)) return null;
    let dirListing = [];
    try {
      const entries = await this.fsProvider.readdir(dir);
      dirListing = entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      logger$9.error(`Failed to list memory dir for ${projectId}:`, error);
      return null;
    }
    const indexPath = path.join(dir, INDEX_FILE_NAME);
    let raw = "";
    if (await this.fsProvider.exists(indexPath)) {
      try {
        raw = await this.fsProvider.readFile(indexPath);
      } catch (error) {
        logger$9.error(`Failed to read MEMORY.md for ${projectId}:`, error);
        raw = "";
      }
    }
    return parseMemoryIndex(raw, dirListing);
  }
  async readFile(projectId, fileName) {
    const absolutePath = this.getFilePath(projectId, fileName);
    const content = await this.fsProvider.readFile(absolutePath);
    return { fileName, absolutePath, content };
  }
  assertSafeMarkdownName(fileName) {
    const trimmed = fileName.trim();
    if (!trimmed) throw new Error("Memory file name is empty");
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(`Memory file name must not contain path separators: ${fileName}`);
    }
    if (trimmed.includes("..")) {
      throw new Error(`Memory file name must not contain '..': ${fileName}`);
    }
    if (!trimmed.toLowerCase().endsWith(".md")) {
      throw new Error(`Memory file must end with .md: ${fileName}`);
    }
    return trimmed;
  }
}
new MemoryReader();
function billedRequestKey$1(m) {
  return m.requestId ?? m.messageId ?? m.message?.id;
}
function inputSideTokens(u) {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
function billedTotalTokens(u) {
  if (!u) return 0;
  return inputSideTokens(u) + (u.output_tokens ?? 0);
}
const TEAMMATE_BLOCK_RE = /<teammate-message\s+teammate_id="([^"]+)"([^>]*)>([\s\S]*?)<\/teammate-message>/g;
function stripTeammateBlocks(t) {
  return t.replace(new RegExp(TEAMMATE_BLOCK_RE.source, TEAMMATE_BLOCK_RE.flags), "");
}
function isTeammateText(t) {
  const trimmed = t.trim();
  return trimmed !== "" && stripTeammateBlocks(trimmed).trim() === "";
}
const SYSTEM_OUTPUT_TAGS = [
  "<local-command-stderr>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  // background task wake-ups: Claude Code inserts them as non-meta user lines
  // (promptSource: "system", turnOrigin: "task_notification") — never user input
  "<task-notification>"
];
function isUserChunkLine(m) {
  if (m.type !== "user" || m.isMeta === true) return false;
  if (isTeammateRelayLine(m)) return false;
  const c = (m.message ?? m).content;
  if (typeof c === "string") {
    const t = c.trim();
    if (t === "" || t.startsWith("[Request interrupted")) return false;
    for (const tag of SYSTEM_OUTPUT_TAGS) {
      if (t.startsWith(tag)) return false;
    }
    return true;
  }
  if (Array.isArray(c)) {
    const hasUserContent = c.some((b) => b && (b.type === "text" || b.type === "image"));
    if (!hasUserContent) return false;
    if (c.length === 1 && c[0].type === "text" && typeof c[0].text === "string" && c[0].text.trim().startsWith("[Request interrupted")) {
      return false;
    }
    for (const b of c) {
      if (b && b.type === "text" && typeof b.text === "string") {
        const t = b.text.trim();
        for (const tag of SYSTEM_OUTPUT_TAGS) {
          if (t.startsWith(tag)) return false;
        }
      }
    }
    return true;
  }
  return false;
}
function isTeammateRelayLine(m) {
  if (m.type !== "user" || m.isMeta === true) return false;
  const c = (m.message ?? m).content;
  const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
  return isTeammateText(texts.join("\n"));
}
function isTranscriptTurnLine(m) {
  return isUserChunkLine(m) || isTeammateRelayLine(m);
}
function isTurnNumberLine(m) {
  if (m.isSidechain === true) return false;
  return isTranscriptTurnLine(m) && m.isCompactSummary !== true;
}
const NOISE_TAG_PATTERNS = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<task-notification>[\s\S]*?<\/task-notification>/gi
];
const TASK_OUTPUT_INSTRUCTION_PATTERN = / ?Read the output file to retrieve the result: [^\s]+/g;
function extractCommandOutput(content) {
  const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i.exec(content);
  const matchStderr = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/i.exec(content);
  if (match) {
    return match[1].trim();
  }
  if (matchStderr) {
    return matchStderr[1].trim();
  }
  return null;
}
function extractCommandDisplay(content) {
  const commandNameMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
  const commandArgsMatch = /<command-args>([^<]*)<\/command-args>/.exec(content);
  if (commandNameMatch) {
    const commandName = `/${commandNameMatch[1].trim()}`;
    const args = commandArgsMatch?.[1]?.trim();
    return args ? `${commandName} ${args}` : commandName;
  }
  return null;
}
function isCommandContent(content) {
  return content.startsWith("<command-name>") || content.startsWith("<command-message>");
}
function isCommandOutputContent(content) {
  return content.startsWith("<local-command-stdout>") || content.startsWith("<local-command-stderr>");
}
function sanitizeDisplayContent(content) {
  if (isCommandOutputContent(content)) {
    const commandOutput = extractCommandOutput(content);
    if (commandOutput) {
      return commandOutput;
    }
  }
  if (isCommandContent(content)) {
    const commandDisplay = extractCommandDisplay(content);
    if (commandDisplay) {
      return commandDisplay;
    }
  }
  let sanitized = content;
  for (const pattern of NOISE_TAG_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  sanitized = sanitized.replace(/<command-name>[\s\S]*?<\/command-name>/gi, "").replace(/<command-message>[\s\S]*?<\/command-message>/gi, "").replace(/<command-args>[\s\S]*?<\/command-args>/gi, "");
  sanitized = sanitized.replace(TASK_OUTPUT_INSTRUCTION_PATTERN, "");
  return sanitized.trim();
}
const KNOWN_FAMILIES = ["sonnet", "opus", "haiku"];
function parseModelString(model) {
  if (!model || model.trim() === "" || model === "<synthetic>") {
    return null;
  }
  const normalized = model.toLowerCase().trim();
  if (!normalized.startsWith("claude")) {
    return null;
  }
  const parts = normalized.split("-");
  if (parts.length < 3) {
    return null;
  }
  let family = null;
  let familyIndex = -1;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (KNOWN_FAMILIES.includes(part)) {
      family = part;
      familyIndex = i;
      break;
    }
  }
  if (family === null) {
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (!/^\d+$/.test(part) && !/^\d{8}$/.test(part) && part.length > 1) {
        family = part;
        familyIndex = i;
        break;
      }
    }
  }
  if (family === null || familyIndex === -1) {
    return null;
  }
  let majorVersion;
  let minorVersion = null;
  if (familyIndex === 1) {
    majorVersion = parseInt(parts[2], 10);
    if (isNaN(majorVersion) || /^\d{8}$/.test(parts[2])) {
      return null;
    }
    if (parts.length >= 4 && parts[3].length <= 2) {
      const potentialMinor = parseInt(parts[3], 10);
      if (!isNaN(potentialMinor)) {
        minorVersion = potentialMinor;
      }
    }
  } else {
    majorVersion = parseInt(parts[1], 10);
    if (isNaN(majorVersion)) {
      return null;
    }
    if (familyIndex > 2) {
      const potentialMinor = parseInt(parts[2], 10);
      if (!isNaN(potentialMinor)) {
        minorVersion = potentialMinor;
      }
    }
  }
  const versionString = minorVersion !== null ? `${majorVersion}.${minorVersion}` : `${majorVersion}`;
  const name = `${family}${versionString}`;
  return {
    name,
    family,
    majorVersion,
    minorVersion
  };
}
const GLM_PRICE = {
  input: 0.075,
  output: 0.25,
  cacheRead: 0.015,
  cacheWrite5m: 0.075,
  cacheWrite1h: 0.075
};
const mkPrice = (input, output, cacheRead, cacheWrite5m, cacheWrite1h) => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h });
function claudePriceFor(family, major, minor) {
  switch (family) {
    case "opus":
      if (major > 5 || major === 5 && minor !== null && minor >= 5) {
        return mkPrice(4, 20, 0.2, 5, 8);
      }
      if (major >= 5 || major === 4 && minor !== null && minor >= 5) {
        return mkPrice(5, 25, 0.5, 6.25, 10);
      }
      return mkPrice(15, 75, 1.5, 18.75, 30);
    case "sonnet":
      return major >= 5 ? mkPrice(2, 10, 0.2, 2.5, 4) : mkPrice(3, 15, 0.3, 3.75, 6);
    case "haiku":
      return major >= 5 ? mkPrice(0.1, 0.5, 0.01, 0.125, 0.2) : mkPrice(1, 5, 0.1, 1.25, 2);
    case "fable":
      return major >= 5 ? mkPrice(10, 50, 0.25, 12.5, 20) : null;
    default:
      return null;
  }
}
function priceForRound(r) {
  const info = parseModelString(r.model);
  if (!info) {
    return r.model.toLowerCase().split("-")[0] === "glm" ? GLM_PRICE : null;
  }
  const price = claudePriceFor(info.family, info.majorVersion, info.minorVersion);
  if (!price || info.family !== "haiku" || info.majorVersion < 5) return price;
  const prompt = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
  return prompt > 1e5 ? { ...price, input: 0.5, output: 2.5 } : price;
}
function roundCostUsd(r) {
  const price = priceForRound(r);
  if (!price) return null;
  const cw5m = r.cacheWrite5mTokens ?? r.cacheCreationTokens;
  const cw1h = r.cacheWrite1hTokens ?? 0;
  return (r.inputTokens * price.input + r.outputTokens * price.output + r.cacheReadTokens * price.cacheRead + cw5m * price.cacheWrite5m + cw1h * price.cacheWrite1h) / 1e6;
}
const logger$8 = createLogger("Service:SessionContentFilter");
const defaultProvider$2 = new LocalFileSystemProvider();
const HARD_NOISE_TAGS$1 = ["<local-command-caveat>", "<system-reminder>"];
const HARD_NOISE_TYPES = ["system", "summary", "file-history-snapshot", "queue-operation"];
class SessionContentFilter {
  /**
   * Checks if a session file contains any displayable conversation items.
   * Returns true if the session has at least one message that would create
   * a visible chunk (UserChunk, SystemChunk, AIChunk, or CompactChunk).
   *
   * Uses the same logic as ChunkBuilder to ensure consistency with ChatHistory:
   * - Sessions that pass this check will have non-empty conversation.items
   * - Sessions that fail will show "No conversation history" in ChatHistory
   *
   * @param filePath - Path to the session JSONL file
   * @returns Promise resolving to true if session has displayable content
   */
  static async hasNonNoiseMessages(filePath, fsProvider = defaultProvider$2) {
    if (!await fsProvider.exists(filePath)) {
      return false;
    }
    const fileStream = fsProvider.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.uuid) {
            continue;
          }
          if (SessionContentFilter.isDisplayableEntry(entry)) {
            fileStream.destroy();
            return true;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      logger$8.error(`Error checking displayable messages in ${filePath}:`, error);
    }
    return false;
  }
  /**
   * Checks if a JSONL entry would create a displayable chunk.
   * Mirrors the logic in ChunkBuilder.categorizeMessage() and isParsed*Message() guards.
   *
   * @param entry - The parsed JSONL entry
   * @returns true if the entry would create a displayable chunk
   */
  static isDisplayableEntry(entry) {
    const entryType = entry.type;
    if (HARD_NOISE_TYPES.includes(entryType)) {
      return false;
    }
    if ("isSidechain" in entry && entry.isSidechain === true) {
      return false;
    }
    if (entryType === "assistant") {
      const assistantEntry = entry;
      return assistantEntry.message?.model !== "<synthetic>";
    }
    if (entryType === "user") {
      return SessionContentFilter.isDisplayableUserEntry(entry);
    }
    return false;
  }
  /**
   * Checks if a user entry is displayable.
   *
   * @param entry - The user entry to check
   * @returns true if the user entry would create a displayable chunk
   */
  static isDisplayableUserEntry(entry) {
    const userEntry = entry;
    const content = userEntry.message?.content;
    const isMeta = userEntry.isMeta;
    if (isMeta === true) {
      return true;
    }
    if (typeof content === "string") {
      return SessionContentFilter.isDisplayableStringContent(content);
    }
    if (Array.isArray(content)) {
      return SessionContentFilter.isDisplayableArrayContent(content);
    }
    return false;
  }
  /**
   * Checks if string content is displayable.
   *
   * @param content - The string content to check
   * @returns true if displayable
   */
  static isDisplayableStringContent(content) {
    const trimmed = content.trim();
    for (const tag of HARD_NOISE_TAGS$1) {
      const openTag = tag;
      const closeTag = tag.replace("<", "</");
      if (trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)) {
        return false;
      }
    }
    if (trimmed.startsWith("<local-command-stdout>") || trimmed.startsWith("<local-command-stderr>")) {
      return true;
    }
    if (trimmed.length > 0) {
      return true;
    }
    return false;
  }
  /**
   * Checks if array content is displayable.
   *
   * @param content - The array content to check
   * @returns true if displayable
   */
  static isDisplayableArrayContent(content) {
    const hasToolResult = content.some((block) => block.type === "tool_result");
    if (hasToolResult) {
      return true;
    }
    const hasUserContent = content.some(
      (block) => block.type === "text" || block.type === "image"
    );
    if (hasUserContent) {
      if (content.length === 1 && content[0].type === "text" && typeof content[0].text === "string" && content[0].text.startsWith("[Request interrupted by user")) {
        return true;
      }
      for (const block of content) {
        if (block.type === "text") {
          const textBlock = block;
          for (const tag of HARD_NOISE_TAGS$1) {
            const closeTag = tag.replace("<", "</");
            if (textBlock.text.startsWith(tag) && textBlock.text.trim().endsWith(closeTag)) {
              return false;
            }
          }
        }
      }
      return true;
    }
    return false;
  }
}
function isTextContent(content) {
  return content.type === "text";
}
function isConversationalEntry(entry) {
  return entry.type === "user" || entry.type === "assistant" || entry.type === "system";
}
const LOCAL_COMMAND_STDOUT_TAG = "<local-command-stdout>";
const LOCAL_COMMAND_STDERR_TAG = "<local-command-stderr>";
const LOCAL_COMMAND_CAVEAT_TAG = "<local-command-caveat>";
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const EMPTY_STDOUT = "<local-command-stdout></local-command-stdout>";
const EMPTY_STDERR = "<local-command-stderr></local-command-stderr>";
const HARD_NOISE_TAGS = [LOCAL_COMMAND_CAVEAT_TAG, SYSTEM_REMINDER_TAG];
function isParsedUserChunkMessage(msg) {
  return isUserChunkLine(msg);
}
function isParsedTeammateRelayMessage(msg) {
  return isTeammateRelayLine(msg);
}
function isParsedSystemChunkMessage(msg) {
  if (msg.type !== "user") return false;
  const content = msg.content;
  if (typeof content === "string") {
    return content.startsWith(LOCAL_COMMAND_STDOUT_TAG) || content.startsWith(LOCAL_COMMAND_STDERR_TAG);
  }
  if (Array.isArray(content)) {
    return content.some(
      (block) => block.type === "text" && block.text.startsWith(LOCAL_COMMAND_STDOUT_TAG)
    );
  }
  return false;
}
function isParsedHardNoiseMessage(msg) {
  if (msg.type === "system") return true;
  if (msg.type === "summary") return true;
  if (msg.type === "file-history-snapshot") return true;
  if (msg.type === "queue-operation") return true;
  if (msg.type === "assistant" && msg.model === "<synthetic>") {
    return true;
  }
  if (msg.type === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      const trimmedContent = content.trim();
      for (const tag of HARD_NOISE_TAGS) {
        const openTag = tag;
        const closeTag = tag.replace("<", "</");
        if (trimmedContent.startsWith(openTag) && trimmedContent.endsWith(closeTag)) {
          return true;
        }
      }
      if (trimmedContent === EMPTY_STDOUT || trimmedContent === EMPTY_STDERR) {
        return true;
      }
      if (trimmedContent.startsWith("[Request interrupted by user")) {
        return true;
      }
    }
    if (Array.isArray(content)) {
      if (content.length === 1 && content[0].type === "text" && typeof content[0].text === "string" && content[0].text.startsWith("[Request interrupted by user")) {
        return true;
      }
    }
  }
  return false;
}
function isParsedCompactMessage(msg) {
  return msg.isCompactSummary === true;
}
const EMPTY_METRICS = {
  durationMs: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messageCount: 0
};
function classifyMessages(messages) {
  return messages.map((message) => ({
    message,
    category: categorizeMessage(message)
  }));
}
function categorizeMessage(message) {
  if (isParsedHardNoiseMessage(message)) {
    return "hardNoise";
  }
  if (isParsedCompactMessage(message)) {
    return "compact";
  }
  if (isParsedSystemChunkMessage(message)) {
    return "system";
  }
  if (isParsedUserChunkMessage(message)) {
    return "user";
  }
  return "ai";
}
function extractToolCalls(content) {
  if (typeof content === "string") {
    return [];
  }
  const toolCalls = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.id && block.name) {
      const input = block.input ?? {};
      const isTask = block.name === "Task" || block.name === "Agent";
      const toolCall = {
        id: block.id,
        name: block.name,
        input,
        isTask
      };
      if (isTask) {
        toolCall.taskDescription = input.description;
        toolCall.taskSubagentType = input.subagent_type;
      }
      toolCalls.push(toolCall);
    }
  }
  return toolCalls;
}
function extractToolResults(content) {
  if (typeof content === "string") {
    return [];
  }
  const toolResults = [];
  for (const block of content) {
    if (block.type === "tool_result" && block.tool_use_id) {
      toolResults.push({
        toolUseId: block.tool_use_id,
        content: block.content ?? "",
        isError: block.is_error ?? false
      });
    }
  }
  return toolResults;
}
const logger$7 = createLogger("Util:metadataExtraction");
const defaultProvider$1 = new LocalFileSystemProvider();
async function extractCwd(filePath, fsProvider = defaultProvider$1) {
  if (!await fsProvider.exists(filePath)) {
    return null;
  }
  const fileStream = fsProvider.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if ("cwd" in entry && entry.cwd) {
        rl.close();
        fileStream.destroy();
        return normalizeDriveLetter(translateWslMountPath(entry.cwd));
      }
    }
  } catch (error) {
    logger$7.error(`Error extracting cwd from ${filePath}:`, error);
  } finally {
    rl.close();
    fileStream.destroy();
  }
  return null;
}
function isToolUseRejection(toolUseResult) {
  return toolUseResult === "User rejected tool use";
}
function isShutdownResponse(block) {
  return block.name === "SendMessage" && block.input?.type === "shutdown_response" && block.input?.approve === true;
}
function isOngoingFromActivities(activities) {
  if (activities.length === 0) {
    return false;
  }
  let lastEndingIndex = -1;
  for (let i = activities.length - 1; i >= 0; i--) {
    const actType = activities[i].type;
    if (actType === "text_output" || actType === "interruption" || actType === "exit_plan_mode") {
      lastEndingIndex = activities[i].index;
      break;
    }
  }
  if (lastEndingIndex === -1) {
    return activities.some(
      (a) => a.type === "thinking" || a.type === "tool_use" || a.type === "tool_result"
    );
  }
  for (const activity of activities) {
    if (activity.index > lastEndingIndex && (activity.type === "thinking" || activity.type === "tool_use" || activity.type === "tool_result")) {
      return true;
    }
  }
  return false;
}
function checkMessagesOngoing(messages) {
  const activities = [];
  let activityIndex = 0;
  const shutdownToolIds = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.type === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinking) {
          activities.push({ type: "thinking", index: activityIndex++ });
        } else if (block.type === "tool_use" && block.id) {
          if (block.name === "ExitPlanMode") {
            activities.push({ type: "exit_plan_mode", index: activityIndex++ });
          } else if (isShutdownResponse(block)) {
            shutdownToolIds.add(block.id);
            activities.push({ type: "interruption", index: activityIndex++ });
          } else {
            activities.push({ type: "tool_use", index: activityIndex++ });
          }
        } else if (block.type === "text" && block.text && String(block.text).trim().length > 0) {
          activities.push({ type: "text_output", index: activityIndex++ });
        }
      }
    } else if (msg.type === "user" && Array.isArray(msg.content)) {
      const isRejection = isToolUseRejection(msg.toolUseResult);
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id)) {
            activities.push({ type: "interruption", index: activityIndex++ });
          } else if (isRejection) {
            activities.push({ type: "interruption", index: activityIndex++ });
          } else {
            activities.push({ type: "tool_result", index: activityIndex++ });
          }
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.startsWith("[Request interrupted by user")) {
          activities.push({ type: "interruption", index: activityIndex++ });
        }
      }
    }
  }
  return isOngoingFromActivities(activities);
}
const logger$6 = createLogger("Util:jsonl");
const defaultProvider = new LocalFileSystemProvider();
async function parseJsonlFile(filePath, fsProvider = defaultProvider) {
  const messages = [];
  if (!await fsProvider.exists(filePath)) {
    return messages;
  }
  const fileStream = fsProvider.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = parseJsonlLine(line);
      if (parsed) {
        messages.push(parsed);
      }
    } catch (error) {
      logger$6.error(`Error parsing line in ${filePath}:`, error);
    }
  }
  return mergeAssistantFragments(messages);
}
function parseJsonlLine(line) {
  if (!line.trim()) {
    return null;
  }
  const entry = JSON.parse(line);
  return parseChatHistoryEntry(entry);
}
function parseChatHistoryEntry(entry) {
  if (!entry.uuid) {
    return null;
  }
  const type = parseMessageType(entry.type);
  if (!type) {
    return null;
  }
  let content = "";
  let role;
  let usage;
  let model;
  let requestId;
  let messageId;
  let cwd;
  let gitBranch;
  let agentId;
  let isSidechain = false;
  let isMeta = false;
  let userType;
  let sourceToolUseID;
  let sourceToolAssistantUUID;
  let toolUseResult;
  let parentUuid = null;
  let isCompactSummary = false;
  if (isConversationalEntry(entry)) {
    cwd = entry.cwd;
    gitBranch = entry.gitBranch;
    isSidechain = entry.isSidechain ?? false;
    userType = entry.userType;
    parentUuid = entry.parentUuid ?? null;
    if (entry.type === "user") {
      content = entry.message.content ?? "";
      role = entry.message.role;
      agentId = entry.agentId;
      isMeta = entry.isMeta ?? false;
      sourceToolUseID = entry.sourceToolUseID;
      sourceToolAssistantUUID = entry.sourceToolAssistantUUID;
      toolUseResult = entry.toolUseResult;
      isCompactSummary = "isCompactSummary" in entry && entry.isCompactSummary === true;
    } else if (entry.type === "assistant") {
      content = entry.message.content;
      role = entry.message.role;
      usage = entry.message.usage;
      model = entry.message.model;
      agentId = entry.agentId;
      requestId = entry.requestId;
      messageId = entry.message.id;
    } else if (entry.type === "system") {
      isMeta = entry.isMeta ?? false;
    }
  }
  const toolCalls = extractToolCalls(content);
  const toolResultsList = extractToolResults(content);
  return {
    uuid: entry.uuid,
    parentUuid,
    type,
    timestamp: entry.timestamp ? new Date(entry.timestamp) : /* @__PURE__ */ new Date(),
    role,
    content,
    usage,
    model,
    // Metadata
    cwd,
    gitBranch,
    agentId,
    isSidechain,
    isMeta,
    userType,
    isCompactSummary,
    // Tool info
    toolCalls,
    toolResults: toolResultsList,
    sourceToolUseID,
    sourceToolAssistantUUID,
    toolUseResult,
    requestId,
    messageId
  };
}
function parseMessageType(type) {
  switch (type) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "summary":
      return "summary";
    case "file-history-snapshot":
      return "file-history-snapshot";
    case "queue-operation":
      return "queue-operation";
    default:
      return null;
  }
}
function billedRequestKey(msg) {
  return billedRequestKey$1(msg);
}
function mergeRequestLines(lines) {
  const last = lines[lines.length - 1];
  if (lines.length === 1) return last;
  let content = lines[0].content;
  let toolCalls = lines[0].toolCalls;
  let toolResults = lines[0].toolResults;
  for (let k = 1; k < lines.length; k++) {
    const next = lines[k];
    content = mergeResponseContent(content, next.content);
    toolCalls = mergeById(toolCalls, next.toolCalls, (tc) => tc.id);
    toolResults = mergeById(toolResults, next.toolResults, (tr) => tr.toolUseId);
  }
  return { ...last, content, toolCalls, toolResults };
}
function snapshotPrefix(prev, next) {
  if (prev.length === 0 || prev.length > next.length) return false;
  return prev.every((b, i) => {
    const n = next[i];
    if (b.type !== n.type) return false;
    if (b.type === "text" && n.type === "text") return (n.text ?? "").startsWith(b.text ?? "");
    if (b.type === "tool_use" && n.type === "tool_use") return b.id === n.id;
    if (b.type === "thinking" && n.type === "thinking") return b.signature === n.signature;
    return JSON.stringify(b) === JSON.stringify(n);
  });
}
function mergeResponseContent(prev, next) {
  const prevBlocks = typeof prev === "string" ? [{ type: "text", text: prev }] : prev ?? [];
  const nextBlocks = typeof next === "string" ? [{ type: "text", text: next }] : next ?? [];
  if (snapshotPrefix(prevBlocks, nextBlocks)) return nextBlocks;
  return concatContent(prev, next);
}
function mergeById(items, add, keyOf) {
  const seen = new Set(items.map(keyOf));
  const out = [...items];
  for (const item of add) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
function deduplicateByRequestId(messages) {
  const indicesByKey = /* @__PURE__ */ new Map();
  for (let i = 0; i < messages.length; i++) {
    const rid = billedRequestKey(messages[i]);
    if (rid) {
      const lines = indicesByKey.get(rid);
      if (lines) lines.push(i);
      else indicesByKey.set(rid, [i]);
    }
  }
  if (indicesByKey.size === 0) {
    return messages;
  }
  const mergedByLastIndex = /* @__PURE__ */ new Map();
  for (const lines of indicesByKey.values()) {
    if (lines.length > 1) {
      mergedByLastIndex.set(
        lines[lines.length - 1],
        mergeRequestLines(lines.map((i) => messages[i]))
      );
    }
  }
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const key = billedRequestKey(messages[i]);
    if (!key) {
      out.push(messages[i]);
      continue;
    }
    const lines = indicesByKey.get(key);
    if (lines?.[lines.length - 1] !== i) continue;
    out.push(mergedByLastIndex.get(i) ?? messages[i]);
  }
  return out;
}
function concatContent(a, b) {
  const aBlocks = typeof a === "string" ? [{ type: "text", text: a }] : a ?? [];
  const bBlocks = typeof b === "string" ? [{ type: "text", text: b }] : b ?? [];
  return typeof a === "string" && typeof b === "string" ? a + b : [...aBlocks, ...bBlocks];
}
function mergeAssistantFragments(messages) {
  const firstIndexByMessageId = /* @__PURE__ */ new Map();
  const result = [];
  for (const msg of messages) {
    if (msg.type !== "assistant" || msg.requestId || !msg.messageId) {
      result.push(msg);
      continue;
    }
    const messageId = msg.messageId;
    const firstIdx = firstIndexByMessageId.get(messageId);
    if (firstIdx === void 0) {
      firstIndexByMessageId.set(messageId, result.length);
      result.push(msg);
      continue;
    }
    const first = result[firstIdx];
    result[firstIdx] = {
      ...first,
      content: concatContent(first.content, msg.content),
      toolCalls: [...first.toolCalls, ...msg.toolCalls],
      toolResults: [...first.toolResults, ...msg.toolResults],
      usage: msg.usage ?? first.usage
    };
  }
  return result;
}
function calculateMetrics(messages) {
  if (messages.length === 0) {
    return { ...EMPTY_METRICS };
  }
  const dedupedMessages = deduplicateByRequestId(messages);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let unpricedRound = false;
  const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
  let minTime = 0;
  let maxTime = 0;
  if (timestamps.length > 0) {
    minTime = timestamps[0];
    maxTime = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < minTime) minTime = timestamps[i];
      if (timestamps[i] > maxTime) maxTime = timestamps[i];
    }
  }
  for (const msg of dedupedMessages) {
    if (msg.usage) {
      inputTokens += msg.usage.input_tokens ?? 0;
      outputTokens += msg.usage.output_tokens ?? 0;
      cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      cacheCreationTokens += msg.usage.cache_creation_input_tokens ?? 0;
    }
  }
  for (const msg of dedupedMessages) {
    if (msg.type !== "assistant" || msg.isSidechain) continue;
    const u = msg.usage;
    if (!u || msg.model === "<synthetic>") continue;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const ttlSplit = cacheWrite > 0 ? u.cache_creation : void 0;
    const c = roundCostUsd({
      model: msg.model ?? "unknown",
      inputTokens: u.input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: cacheWrite,
      outputTokens: u.output_tokens ?? 0,
      cacheWrite5mTokens: ttlSplit ? ttlSplit.ephemeral_5m_input_tokens ?? 0 : void 0,
      cacheWrite1hTokens: ttlSplit ? ttlSplit.ephemeral_1h_input_tokens ?? 0 : void 0
    });
    if (c === null) unpricedRound = true;
    else costUsd += c;
  }
  return {
    durationMs: maxTime - minTime,
    totalTokens: inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messageCount: messages.length,
    costUsd: costUsd > 0 ? costUsd : void 0,
    costPartial: costUsd > 0 ? unpricedRound : void 0
  };
}
function getTaskCalls(messages) {
  return messages.flatMap((m) => m.toolCalls.filter((tc) => tc.isTask));
}
async function analyzeSessionFileMetadata(filePath, fsProvider = defaultProvider) {
  if (!await fsProvider.exists(filePath)) {
    return {
      firstUserMessage: null,
      messageCount: 0,
      isOngoing: false,
      gitBranch: null,
      totalTokens: 0,
      turnCount: 0,
      hasDisplayableContent: false
    };
  }
  const fileStream = fsProvider.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  let firstUserMessage = null;
  let firstCommandMessage = null;
  let lastName = null;
  const lastAiTitle = null;
  let messageCount = 0;
  let hasDisplayableContent = false;
  let awaitingAIGroup = false;
  let turnCount = 0;
  let hasTurnInput = false;
  let inAssistantRun = false;
  let gitBranch = null;
  let activityIndex = 0;
  let lastEndingIndex = -1;
  let hasAnyOngoingActivity = false;
  let hasActivityAfterLastEnding = false;
  const shutdownToolIds = /* @__PURE__ */ new Set();
  let lastMainAssistantInputTokens = 0;
  const compactionPhases = [];
  let awaitingPostCompaction = false;
  let totalTokens = 0;
  const billedRequests = /* @__PURE__ */ new Set();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entryName = sessionNameFromEntry(entry);
    if (entryName) {
      lastName = entryName;
    }
    const parsed = parseChatHistoryEntry(entry);
    if (!parsed) {
      continue;
    }
    if (!hasDisplayableContent && entry.uuid) {
      if (SessionContentFilter.isDisplayableEntry(entry)) {
        hasDisplayableContent = true;
      }
    }
    const isUserTurn = isParsedUserChunkMessage(parsed);
    if (isUserTurn || isParsedTeammateRelayMessage(parsed)) {
      if (isUserTurn) {
        messageCount++;
        awaitingAIGroup = true;
      }
      if (!parsed.isSidechain && !parsed.isCompactSummary) {
        turnCount++;
        hasTurnInput = true;
      }
    } else if (awaitingAIGroup && parsed.type === "assistant" && parsed.model !== "<synthetic>" && !parsed.isSidechain) {
      messageCount++;
      awaitingAIGroup = false;
    }
    const category = categorizeMessage(parsed);
    if (!hasTurnInput && !parsed.isSidechain && category === "ai" && parsed.type === "assistant") {
      if (!inAssistantRun) {
        turnCount++;
        inAssistantRun = true;
      }
    } else if (!parsed.isSidechain && (category === "user" || category === "system" || category === "compact")) {
      inAssistantRun = false;
    }
    if (!gitBranch && "gitBranch" in entry && entry.gitBranch) {
      gitBranch = entry.gitBranch;
    }
    if (!firstUserMessage && // teammate relays (and system output/interruptions) must not become the preview
    isParsedUserChunkMessage(parsed) && entry.type === "user" && !("isMeta" in entry && entry.isMeta === true)) {
      const content = entry.message?.content;
      if (typeof content === "string") {
        if (isCommandOutputContent(content)) ;
        else if (content.startsWith("[Request interrupted by user")) ;
        else if (content.startsWith("<command-name>")) {
          if (!firstCommandMessage) {
            const commandMatch = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
            const commandName = commandMatch ? `/${commandMatch[1]}` : "/command";
            firstCommandMessage = {
              text: commandName,
              timestamp: entry.timestamp ?? (/* @__PURE__ */ new Date()).toISOString()
            };
          }
        } else {
          const sanitized = sanitizeDisplayContent(content);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: entry.timestamp ?? (/* @__PURE__ */ new Date()).toISOString()
            };
          }
        }
      } else if (Array.isArray(content)) {
        const textContent = content.filter(isTextContent).map((b) => b.text).join(" ");
        if (textContent && !textContent.startsWith("<command-name>") && !textContent.startsWith("[Request interrupted by user")) {
          const sanitized = sanitizeDisplayContent(textContent);
          if (sanitized.length > 0) {
            firstUserMessage = {
              text: sanitized.substring(0, 500),
              timestamp: entry.timestamp ?? (/* @__PURE__ */ new Date()).toISOString()
            };
          }
        }
      }
    }
    if (parsed.type === "assistant" && Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block.type === "thinking" && block.thinking) {
          hasAnyOngoingActivity = true;
          if (lastEndingIndex >= 0) {
            hasActivityAfterLastEnding = true;
          }
          activityIndex++;
        } else if (block.type === "tool_use" && block.id) {
          if (block.name === "ExitPlanMode") {
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else if (block.name === "SendMessage" && block.input?.type === "shutdown_response" && block.input?.approve === true) {
            shutdownToolIds.add(block.id);
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (block.type === "text" && block.text && String(block.text).trim().length > 0) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    } else if (parsed.type === "user" && Array.isArray(parsed.content)) {
      const isRejection = "toolUseResult" in entry && entry.toolUseResult === "User rejected tool use";
      for (const block of parsed.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id) || isRejection) {
            lastEndingIndex = activityIndex++;
            hasActivityAfterLastEnding = false;
          } else {
            hasAnyOngoingActivity = true;
            if (lastEndingIndex >= 0) {
              hasActivityAfterLastEnding = true;
            }
            activityIndex++;
          }
        } else if (block.type === "text" && typeof block.text === "string" && block.text.startsWith("[Request interrupted by user")) {
          lastEndingIndex = activityIndex++;
          hasActivityAfterLastEnding = false;
        }
      }
    }
    if (parsed.type === "assistant" && !parsed.isSidechain && parsed.model !== "<synthetic>") {
      const inputTokens = (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.cache_read_input_tokens ?? 0) + (parsed.usage?.cache_creation_input_tokens ?? 0);
      if (inputTokens > 0) {
        if (awaitingPostCompaction && compactionPhases.length > 0) {
          compactionPhases[compactionPhases.length - 1].post = inputTokens;
          awaitingPostCompaction = false;
        }
        lastMainAssistantInputTokens = inputTokens;
      }
    }
    if (parsed.type === "assistant" && parsed.usage) {
      const requestKey = billedRequestKey(parsed);
      if (!requestKey || !billedRequests.has(requestKey)) {
        if (requestKey) billedRequests.add(requestKey);
        totalTokens += billedTotalTokens(parsed.usage);
      }
    }
    if (parsed.isCompactSummary) {
      compactionPhases.push({ pre: lastMainAssistantInputTokens, post: 0 });
      awaitingPostCompaction = true;
    }
  }
  let contextConsumption;
  let phaseBreakdown;
  if (lastMainAssistantInputTokens > 0) {
    if (compactionPhases.length === 0) {
      contextConsumption = lastMainAssistantInputTokens;
      phaseBreakdown = [
        {
          phaseNumber: 1,
          contribution: lastMainAssistantInputTokens,
          peakTokens: lastMainAssistantInputTokens
        }
      ];
    } else {
      phaseBreakdown = [];
      let total = 0;
      const phase1Contribution = compactionPhases[0].pre;
      total += phase1Contribution;
      phaseBreakdown.push({
        phaseNumber: 1,
        contribution: phase1Contribution,
        peakTokens: compactionPhases[0].pre,
        postCompaction: compactionPhases[0].post
      });
      for (let i = 1; i < compactionPhases.length; i++) {
        const contribution = compactionPhases[i].pre - compactionPhases[i - 1].post;
        total += contribution;
        phaseBreakdown.push({
          phaseNumber: i + 1,
          contribution,
          peakTokens: compactionPhases[i].pre,
          postCompaction: compactionPhases[i].post
        });
      }
      const lastPhase = compactionPhases[compactionPhases.length - 1];
      if (lastPhase.post > 0) {
        const lastContribution = lastMainAssistantInputTokens - lastPhase.post;
        total += lastContribution;
        phaseBreakdown.push({
          phaseNumber: compactionPhases.length + 1,
          contribution: lastContribution,
          peakTokens: lastMainAssistantInputTokens
        });
      }
      contextConsumption = total;
    }
  }
  return {
    firstUserMessage: firstUserMessage ?? firstCommandMessage,
    name: lastName ?? lastAiTitle,
    messageCount,
    isOngoing: lastEndingIndex === -1 ? hasAnyOngoingActivity : hasActivityAfterLastEnding,
    gitBranch,
    contextConsumption,
    compactionCount: compactionPhases.length > 0 ? compactionPhases.length : void 0,
    phaseBreakdown,
    totalTokens,
    turnCount,
    hasDisplayableContent
  };
}
function sessionNameFromEntry(entry) {
  if (entry.type === "agent-name") return entry.agentName;
  if (entry.type === "ai-title") return entry.aiTitle;
  return null;
}
async function readSessionName(filePath, fsProvider = defaultProvider) {
  let name = null;
  const fileStream = fsProvider.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entryName = sessionNameFromEntry(entry);
    if (entryName) name = entryName;
  }
  return name;
}
class SubprojectRegistryImpl {
  constructor() {
    this.entries = /* @__PURE__ */ new Map();
  }
  /**
   * Register a subproject and return its composite ID.
   *
   * @param baseDir - The encoded directory name (e.g., "-Users-name-project")
   * @param cwd - The actual working directory for this subproject
   * @param sessionIds - Session IDs belonging to this subproject
   * @returns Composite ID in the form `{baseDir}::{hash}`
   */
  register(baseDir, cwd, sessionIds) {
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
    const compositeId = `${baseDir}::${hash}`;
    this.entries.set(compositeId, {
      baseDir,
      cwd,
      sessionIds: new Set(sessionIds)
    });
    return compositeId;
  }
  /**
   * Extract the base directory from any project ID (composite or plain).
   * For composite IDs (`{encoded}::{hash}`), returns the encoded part.
   * For plain IDs, returns the ID as-is.
   */
  getBaseDir(projectId) {
    const sep = projectId.indexOf("::");
    if (sep !== -1) {
      return projectId.slice(0, sep);
    }
    return projectId;
  }
  /**
   * Check if a project ID is a composite (split) ID.
   */
  isComposite(projectId) {
    return projectId.includes("::");
  }
  /**
   * Get the session ID filter set for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getSessionFilter(projectId) {
    const entry = this.entries.get(projectId);
    return entry?.sessionIds ?? null;
  }
  /**
   * Get the cwd for a composite project ID.
   * Returns null for plain (non-composite) IDs.
   */
  getCwd(projectId) {
    const entry = this.entries.get(projectId);
    return entry?.cwd ?? null;
  }
  /**
   * Get the full entry for a composite project ID.
   */
  getEntry(projectId) {
    return this.entries.get(projectId);
  }
  /**
   * Clear all registered subprojects. Called at the start of a full re-scan.
   */
  clear() {
    this.entries.clear();
  }
}
const subprojectRegistry = new SubprojectRegistryImpl();
const logger$5 = createLogger("Discovery:ProjectPathResolver");
class ProjectPathResolver {
  constructor(projectsDir, fsProvider) {
    this.projectPathCache = /* @__PURE__ */ new Map();
    this.projectsDir = projectsDir ?? getProjectsBasePath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }
  /**
   * Resolve a project ID to a canonical path.
   */
  async resolveProjectPath(projectId, options) {
    const opts = options ?? {};
    const registryCwd = subprojectRegistry.getCwd(projectId);
    if (registryCwd) {
      this.projectPathCache.set(projectId, registryCwd);
      return registryCwd;
    }
    if (!opts.forceRefresh) {
      const cached = this.projectPathCache.get(projectId);
      if (cached) {
        return cached;
      }
    }
    const cwdHint = opts.cwdHint?.trim();
    if (cwdHint && path.isAbsolute(cwdHint)) {
      this.projectPathCache.set(projectId, cwdHint);
      return cwdHint;
    }
    const sessionPaths = opts.sessionPaths?.length ? opts.sessionPaths : await this.listSessionPaths(projectId);
    const maxPathsToInspect = this.fsProvider.type === "ssh" ? 1 : sessionPaths.length;
    for (const sessionPath of sessionPaths.slice(0, maxPathsToInspect)) {
      try {
        const cwd = await extractCwd(sessionPath, this.fsProvider);
        if (cwd && path.isAbsolute(cwd)) {
          this.projectPathCache.set(projectId, cwd);
          return cwd;
        }
      } catch {
      }
    }
    const decoded = decodePath(extractBaseDir(projectId));
    this.projectPathCache.set(projectId, decoded);
    return decoded;
  }
  /**
   * Invalidate a single project's cached path.
   */
  invalidateProject(projectId) {
    this.projectPathCache.delete(projectId);
  }
  /**
   * Clear all cached project paths.
   */
  clear() {
    this.projectPathCache.clear();
  }
  async listSessionPaths(projectId) {
    const projectDir = path.join(this.projectsDir, extractBaseDir(projectId));
    if (!await this.fsProvider.exists(projectDir)) {
      return [];
    }
    try {
      const entries = await this.fsProvider.readdir(projectDir);
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(projectDir, entry.name));
    } catch (error) {
      logger$5.error(`Failed to read session files for ${projectId}:`, error);
      return [];
    }
  }
}
new ProjectPathResolver();
class SearchTextCache {
  constructor(maxSize = 1e3) {
    this.cache = /* @__PURE__ */ new Map();
    this.maxSize = maxSize;
  }
  /**
   * Get cached entries for a file path if the mtime matches.
   * Returns undefined if not cached or stale.
   */
  get(filePath, mtimeMs) {
    const entry = this.cache.get(filePath);
    if (!entry) return void 0;
    if (entry.mtimeMs !== mtimeMs) {
      this.cache.delete(filePath);
      return void 0;
    }
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);
    return { entries: entry.entries, sessionTitle: entry.sessionTitle };
  }
  /**
   * Cache extracted entries for a file path.
   */
  set(filePath, mtimeMs, entries, sessionTitle) {
    this.cache.delete(filePath);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== void 0) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(filePath, { entries, sessionTitle, mtimeMs });
  }
  /**
   * Remove a specific entry from the cache.
   */
  invalidate(filePath) {
    this.cache.delete(filePath);
  }
  /**
   * Clear all cached entries.
   */
  clear() {
    this.cache.clear();
  }
  /**
   * Current number of cached entries.
   */
  get size() {
    return this.cache.size;
  }
}
function extractSearchableEntries(messages) {
  const entries = [];
  let sessionTitle;
  const mainMessages = messages.filter((m) => !m.isSidechain);
  const classified = classifyMessages(mainMessages);
  let aiBuffer = [];
  const flushAIBuffer = () => {
    if (aiBuffer.length === 0) return;
    const aiEntry = extractAIEntry(aiBuffer);
    if (aiEntry) entries.push(aiEntry);
    entries.push(...extractAIToolEntries(aiBuffer));
    aiBuffer = [];
  };
  for (const { message, category } of classified) {
    switch (category) {
      case "hardNoise":
        break;
      case "compact":
      case "system":
        flushAIBuffer();
        if (category === "system") {
          const text = extractUserText(message);
          if (text) {
            entries.push({
              text,
              groupId: `system-${message.uuid}`,
              messageType: "assistant",
              itemType: "ai",
              timestamp: message.timestamp.getTime(),
              messageUuid: message.uuid
            });
          }
        }
        break;
      case "user": {
        flushAIBuffer();
        const userText = extractUserText(message);
        if (userText) {
          if (!sessionTitle) {
            sessionTitle = userText.slice(0, 100);
          }
          entries.push({
            text: userText,
            groupId: `user-${message.uuid}`,
            messageType: "user",
            itemType: "user",
            timestamp: message.timestamp.getTime(),
            messageUuid: message.uuid
          });
        }
        break;
      }
      case "ai":
        aiBuffer.push(message);
        break;
    }
  }
  flushAIBuffer();
  return { entries, sessionTitle };
}
function extractAIEntry(buffer) {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const msg = buffer[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type === "text" && block.text) {
        return {
          text: block.text,
          groupId: `ai-${buffer[0].uuid}`,
          messageType: "assistant",
          itemType: "ai",
          timestamp: msg.timestamp.getTime(),
          messageUuid: msg.uuid
        };
      }
    }
  }
  return null;
}
function extractAIToolEntries(buffer) {
  const entries = [];
  const groupId = `ai-${buffer[0].uuid}`;
  for (const msg of buffer) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const toolText = block.type === "tool_use" ? `${block.name} ${JSON.stringify(block.input)}` : block.type === "tool_result" ? toolResultText(block.content) : "";
      if (!toolText) continue;
      entries.push({
        text: toolText,
        groupId,
        messageType: "assistant",
        itemType: "ai",
        timestamp: msg.timestamp.getTime(),
        messageUuid: msg.uuid
      });
    }
  }
  return entries;
}
function toolResultText(content) {
  if (typeof content === "string") return sanitizeDisplayContent(content);
  if (Array.isArray(content)) {
    return sanitizeDisplayContent(
      content.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n")
    );
  }
  return "";
}
function extractUserText(message) {
  let rawText = "";
  if (typeof message.content === "string") {
    rawText = message.content;
  } else if (Array.isArray(message.content)) {
    rawText = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return sanitizeDisplayContent(rawText);
}
const logger$4 = createLogger("Discovery:SessionSearcher");
const SSH_FAST_SEARCH_STAGE_LIMITS = [40, 140, 320];
const SSH_FAST_SEARCH_MIN_RESULTS = 8;
const SSH_FAST_SEARCH_TIME_BUDGET_MS = 4500;
class SessionSearcher {
  constructor(projectsDir, fsProvider) {
    this.projectsDir = projectsDir;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
    this.searchCache = new SearchTextCache();
  }
  /**
   * Searches sessions in a project for a query string.
   * Filters out noise messages and returns matching content.
   *
   * @param projectId - The project ID to search in
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 50)
   * @returns Search results with matches and metadata
   */
  async searchSessions(projectId, query, maxResults = 50) {
    const startedAt = Date.now();
    const results = [];
    let sessionsSearched = 0;
    const fastMode = this.fsProvider.type === "ssh";
    let isPartial = false;
    if (!query || query.trim().length === 0) {
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
    const normalizedQuery = query.toLowerCase().trim();
    try {
      const baseDir = extractBaseDir(projectId);
      const projectPath = path.join(this.projectsDir, baseDir);
      const sessionFilter = subprojectRegistry.getSessionFilter(projectId);
      if (!await this.fsProvider.exists(projectPath)) {
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }
      const entries = await this.fsProvider.readdir(projectPath);
      const sessionEntries = entries.filter((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return false;
        if (sessionFilter) {
          const sessionId = extractSessionId(entry.name);
          return sessionFilter.has(sessionId);
        }
        return true;
      });
      const sessionFiles = await this.collectFulfilledInBatches(
        sessionEntries,
        this.fsProvider.type === "ssh" ? 24 : 128,
        async (entry) => {
          const filePath = path.join(projectPath, entry.name);
          const mtimeMs = typeof entry.mtimeMs === "number" ? entry.mtimeMs : (await this.fsProvider.stat(filePath)).mtimeMs;
          return { name: entry.name, filePath, mtimeMs };
        }
      );
      sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const searchBatchSize = fastMode ? 3 : 16;
      const stageBoundaries = fastMode ? this.buildFastSearchStageBoundaries(sessionFiles.length) : [sessionFiles.length];
      let searchedUntil = 0;
      let shouldStop = false;
      for (const stageBoundary of stageBoundaries) {
        for (let i = searchedUntil; i < stageBoundary && results.length < maxResults; i += searchBatchSize) {
          if (fastMode && Date.now() - startedAt >= SSH_FAST_SEARCH_TIME_BUDGET_MS) {
            isPartial = true;
            shouldStop = true;
            break;
          }
          const batch = sessionFiles.slice(i, i + searchBatchSize);
          sessionsSearched += batch.length;
          const settled = await Promise.allSettled(
            batch.map(async (file) => {
              const sessionId = extractSessionId(file.name);
              return this.searchSessionFile(
                projectId,
                sessionId,
                file.filePath,
                normalizedQuery,
                maxResults,
                file.mtimeMs
              );
            })
          );
          for (const result of settled) {
            if (results.length >= maxResults) {
              break;
            }
            if (result.status !== "fulfilled" || result.value.length === 0) {
              continue;
            }
            const remaining = maxResults - results.length;
            results.push(...result.value.slice(0, remaining));
          }
        }
        searchedUntil = stageBoundary;
        if (shouldStop || !fastMode || results.length >= maxResults) {
          break;
        }
        if (stageBoundary < sessionFiles.length && results.length >= SSH_FAST_SEARCH_MIN_RESULTS) {
          isPartial = true;
          break;
        }
      }
      if (fastMode && results.length < maxResults && sessionsSearched < sessionFiles.length) {
        isPartial = true;
      }
      if (fastMode) {
        logger$4.debug(
          `SSH fast search scanned ${sessionsSearched}/${sessionFiles.length} sessions in ${Date.now() - startedAt}ms (results=${results.length}, partial=${isPartial})`
        );
      }
      return {
        results,
        totalMatches: results.length,
        sessionsSearched,
        query,
        isPartial: fastMode ? isPartial : void 0
      };
    } catch (error) {
      logger$4.error(`Error searching sessions for project ${projectId}:`, error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  }
  /**
   * Searches a single session file for a query string.
   *
   * Uses SearchTextExtractor for lightweight text extraction (no ChunkBuilder)
   * and SearchTextCache for mtime-based caching.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @param filePath - Path to the session file
   * @param query - Normalized search query (lowercase)
   * @param maxResults - Maximum number of results to return
   * @param mtimeMs - File modification time for cache invalidation
   * @returns Array of search results
   */
  async searchSessionFile(projectId, sessionId, filePath, query, maxResults, mtimeMs) {
    const results = [];
    let cached = this.searchCache.get(filePath, mtimeMs);
    if (!cached) {
      const messages = await parseJsonlFile(filePath, this.fsProvider);
      const extracted = extractSearchableEntries(messages);
      const name = await readSessionName(filePath, this.fsProvider);
      if (name) {
        extracted.entries.unshift({
          text: name,
          groupId: "session-name",
          messageType: "user",
          itemType: "user",
          timestamp: mtimeMs,
          messageUuid: "session-name"
        });
        extracted.sessionTitle = name;
      }
      this.searchCache.set(filePath, mtimeMs, extracted.entries, extracted.sessionTitle);
      cached = extracted;
    }
    const { entries, sessionTitle } = cached;
    const hasAnyMatch = entries.some((entry) => entry.text.toLowerCase().includes(query));
    if (!hasAnyMatch) return results;
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      this.collectMatchesForEntry(
        entry,
        query,
        results,
        maxResults,
        projectId,
        sessionId,
        sessionTitle
      );
    }
    return results;
  }
  collectMatchesForEntry(entry, query, results, maxResults, projectId, sessionId, sessionTitle) {
    const lowerText = entry.text.toLowerCase();
    if (!lowerText.includes(query)) return;
    let pos = 0;
    let matchIndex = 0;
    while ((pos = lowerText.indexOf(query, pos)) !== -1) {
      if (results.length >= maxResults) return;
      const contextStart = Math.max(0, pos - 50);
      const contextEnd = Math.min(entry.text.length, pos + query.length + 50);
      const context = entry.text.slice(contextStart, contextEnd);
      const matchedText = entry.text.slice(pos, pos + query.length);
      results.push({
        sessionId,
        projectId,
        sessionTitle: sessionTitle ?? "Untitled Session",
        matchedText,
        context: (contextStart > 0 ? "..." : "") + context + (contextEnd < entry.text.length ? "..." : ""),
        messageType: entry.messageType,
        timestamp: entry.timestamp,
        groupId: entry.groupId,
        itemType: entry.itemType,
        matchIndexInItem: matchIndex,
        matchStartOffset: pos,
        messageUuid: entry.messageUuid
      });
      matchIndex++;
      pos += query.length;
    }
  }
  async collectFulfilledInBatches(items, batchSize, mapper) {
    const safeBatchSize = Math.max(1, batchSize);
    const results = [];
    for (let i = 0; i < items.length; i += safeBatchSize) {
      const batch = items.slice(i, i + safeBatchSize);
      const settled = await Promise.allSettled(batch.map((item) => mapper(item)));
      for (const result of settled) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    }
    return results;
  }
  buildFastSearchStageBoundaries(totalFiles) {
    if (totalFiles <= 0) {
      return [];
    }
    const boundaries = [];
    for (const limit of SSH_FAST_SEARCH_STAGE_LIMITS) {
      const boundary = Math.min(totalFiles, limit);
      if (boundaries.length === 0 || boundary > boundaries[boundaries.length - 1]) {
        boundaries.push(boundary);
      }
    }
    if (boundaries.length === 0) {
      boundaries.push(totalFiles);
    }
    return boundaries;
  }
}
const logger$3 = createLogger("Discovery:SubagentLocator");
class SubagentLocator {
  constructor(projectsDir, fsProvider) {
    this.projectsDir = projectsDir;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }
  /**
   * Checks if a session has subagent files (async).
   * Uses the FileSystemProvider for filesystem access.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to true if subagents exist
   */
  async hasSubagents(projectId, sessionId) {
    const newSubagentsPath = this.getSubagentsPath(projectId, sessionId);
    if (await this.fsProvider.exists(newSubagentsPath)) {
      try {
        const entries = await this.fsProvider.readdir(newSubagentsPath);
        const subagentFiles = entries.filter(
          (entry) => entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")
        );
        for (const entry of subagentFiles) {
          const filePath = path.join(newSubagentsPath, entry.name);
          try {
            const stats = await this.fsProvider.stat(filePath);
            if (stats.size > 0) {
              const content = await this.fsProvider.readFile(filePath);
              if (content.trim().length > 0) {
                return true;
              }
            }
          } catch (error) {
            logger$3.debug(`SubagentLocator: Could not read file ${filePath}:`, error);
            continue;
          }
        }
      } catch {
      }
    }
    return false;
  }
  /**
   * Lists all subagent files for a session from both NEW and OLD structures.
   * Returns NEW structure files first, then OLD structure files.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to array of file paths
   */
  async listSubagentFiles(projectId, sessionId) {
    const allFiles = [];
    try {
      const newSubagentsPath = this.getSubagentsPath(projectId, sessionId);
      if (await this.fsProvider.exists(newSubagentsPath)) {
        const entries = await this.fsProvider.readdir(newSubagentsPath);
        const newFiles = entries.filter(
          (entry) => entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")
        ).map((entry) => path.join(newSubagentsPath, entry.name));
        allFiles.push(...newFiles);
      }
    } catch (error) {
      logger$3.error(`Error scanning NEW subagent structure for session ${sessionId}:`, error);
    }
    try {
      const oldFiles = await this.getProjectRootSubagentFiles(projectId, sessionId);
      allFiles.push(...oldFiles);
    } catch (error) {
      logger$3.error(`Error scanning OLD subagent structure for project ${projectId}:`, error);
    }
    return allFiles;
  }
  /**
   * Gets subagent files from project root (OLD structure).
   * Scans {projectId}/agent-*.jsonl files and filters by sessionId.
   *
   * In the OLD structure, all subagent files are in the project root,
   * so we must read each file's first line to check if it belongs to the session.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Promise resolving to array of file paths
   */
  async getProjectRootSubagentFiles(projectId, sessionId) {
    try {
      const projectPath = path.join(this.projectsDir, extractBaseDir(projectId));
      if (!await this.fsProvider.exists(projectPath)) {
        return [];
      }
      const entries = await this.fsProvider.readdir(projectPath);
      const agentFiles = entries.filter((entry) => entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")).map((entry) => path.join(projectPath, entry.name));
      const matchingFiles = [];
      for (const filePath of agentFiles) {
        if (await this.subagentBelongsToSession(filePath, sessionId)) {
          matchingFiles.push(filePath);
        }
      }
      return matchingFiles;
    } catch (error) {
      logger$3.error(`Error reading project root for subagent files:`, error);
      return [];
    }
  }
  /**
   * Checks if a subagent file belongs to a specific session by reading its first line.
   * Subagent files have a sessionId field that points to the parent session.
   *
   * @param filePath - Path to the subagent file
   * @param sessionId - The session ID to check
   * @returns Promise resolving to true if the subagent belongs to the session
   */
  async subagentBelongsToSession(filePath, sessionId) {
    try {
      const content = await this.fsProvider.readFile(filePath);
      const firstNewline = content.indexOf("\n");
      const firstLine = firstNewline > 0 ? content.slice(0, firstNewline) : content;
      if (!firstLine.trim()) {
        return false;
      }
      const entry = JSON.parse(firstLine);
      return entry.sessionId === sessionId;
    } catch (error) {
      logger$3.debug(`SubagentLocator: Could not parse file ${filePath}:`, error);
      return false;
    }
  }
  /**
   * Gets the path to the subagents directory.
   *
   * @param projectId - The project ID
   * @param sessionId - The session ID
   * @returns Path to the subagents directory
   */
  getSubagentsPath(projectId, sessionId) {
    return buildSubagentsPath(this.projectsDir, projectId, sessionId);
  }
}
const WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const TASKS_DIR = "tasks";
const CURSOR_DIR = ".cursor";
const VIBE_KANBAN_DIR = "vibe-kanban";
const CONDUCTOR_DIR = "conductor";
const AUTO_CLAUDE_DIR = ".auto-claude";
const TWENTYFIRST_DIR = ".21st";
const CLAUDE_WORKTREES_DIR = ".claude-worktrees";
const CCSWITCH_DIR = ".ccswitch";
const logger$2 = createLogger("Service:GitIdentityResolver");
class GitIdentityResolver {
  /**
   * Helper to find the nearest .git file or directory by searching upwards.
   */
  async findGitPath(projectPath) {
    try {
      let currentPath = path.resolve(projectPath);
      while (currentPath) {
        const gitPath = path.join(currentPath, ".git");
        try {
          const stats = await fs.promises.stat(gitPath);
          if (stats.isFile() || stats.isDirectory()) {
            return { repoRoot: currentPath, gitPath, stats };
          }
        } catch {
        }
        const parentDir = path.dirname(currentPath);
        if (parentDir === currentPath) {
          break;
        }
        currentPath = parentDir;
      }
    } catch {
    }
    return null;
  }
  /**
   * Resolve repository identity from a project path.
   *
   * Algorithm:
   * 1. Check if path/.git exists on filesystem
   * 2. If .git is a file (worktree), read gitdir to find main repo
   * 3. If .git is a directory (main repo), use it directly
   * 4. Extract remote URL from .git/config
   * 5. Build RepositoryIdentity with consistent ID
   * 6. FALLBACK: If path doesn't exist, use heuristics based on path patterns
   *
   * @param projectPath - The filesystem path to check
   * @returns RepositoryIdentity or null if not a git repo
   */
  async resolveIdentity(projectPath) {
    try {
      const gitInfo = await this.findGitPath(projectPath);
      if (gitInfo) {
        const { repoRoot: currentPath, gitPath, stats } = gitInfo;
        let mainGitDir;
        if (stats.isFile()) {
          const gitFileContent = (await fs.promises.readFile(gitPath, "utf-8")).trim();
          const gitDirMatch = /^gitdir:\s*(\S[^\r\n]*)$/m.exec(gitFileContent);
          if (!gitDirMatch) {
            logger$2.warn(`Invalid .git file format at ${gitPath}`);
            return this.resolveIdentityFromPath(projectPath);
          }
          let worktreeGitDir = gitDirMatch[1].trim();
          if (!path.isAbsolute(worktreeGitDir)) {
            worktreeGitDir = path.resolve(currentPath, worktreeGitDir);
          }
          mainGitDir = this.extractMainGitDir(worktreeGitDir);
        } else if (stats.isDirectory()) {
          mainGitDir = gitPath;
        } else {
          return this.resolveIdentityFromPath(projectPath);
        }
        try {
          mainGitDir = await fs.promises.realpath(mainGitDir);
        } catch {
        }
        const remoteUrl = await this.getRemoteUrl(mainGitDir);
        const repoId = this.generateRepoId(remoteUrl, mainGitDir);
        const repoName = this.extractRepoName(remoteUrl, mainGitDir);
        return {
          id: repoId,
          remoteUrl: remoteUrl ?? void 0,
          mainGitDir,
          name: repoName
        };
      }
      return this.resolveIdentityFromPath(projectPath);
    } catch (error) {
      logger$2.error(`Error resolving git identity for ${projectPath}:`, error);
      return this.resolveIdentityFromPath(projectPath);
    }
  }
  /**
   * Fallback: Resolve repository identity from path patterns when filesystem is unavailable.
   * Uses heuristics to detect common worktree path patterns.
   *
   * Patterns supported:
   * - /.cursor/worktrees/{repo}/{worktree-name}
   * - /vibe-kanban/worktrees/{issue-branch}/{repo}
   * - /T/vibe-kanban/worktrees/{issue-branch}/{repo}
   * - Regular paths: use last component as repo name
   */
  resolveIdentityFromPath(projectPath) {
    const repoName = this.extractRepoNameFromPath(projectPath);
    if (!repoName) {
      return null;
    }
    const repoId = this.generateRepoId(null, projectPath);
    return {
      id: repoId,
      remoteUrl: void 0,
      mainGitDir: repoName,
      // Use repo name as placeholder
      name: repoName
    };
  }
  /**
   * Extract repository name from path using heuristics.
   * Works for both existing and deleted worktrees based on path patterns.
   *
   * Patterns:
   * - /.cursor/worktrees/{repo}/{worktree} → repo
   * - /vibe-kanban/worktrees/{issue-branch}/{repo} → repo (last component)
   * - /conductor/workspaces/{repo}/{subpath} → repo
   * - /.auto-claude/worktrees/tasks/{task-id} → parent repo (2 levels up from .auto-claude)
   * - /.21st/worktrees/{id}/{name} → parent repo
   * - /.claude-worktrees/{repo}/{name} → repo
   * - /.ccswitch/worktrees/{repo}/{name} → repo
   * - Default: last path component
   */
  extractRepoNameFromPath(projectPath) {
    const parts = projectPath.split(path.sep).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    const cursorWorktreeIdx = parts.indexOf(CURSOR_DIR);
    if (cursorWorktreeIdx >= 0 && parts[cursorWorktreeIdx + 1] === WORKTREES_DIR) {
      if (parts[cursorWorktreeIdx + 2]) {
        return parts[cursorWorktreeIdx + 2];
      }
    }
    const vibeKanbanIdx = parts.indexOf(VIBE_KANBAN_DIR);
    if (vibeKanbanIdx >= 0 && parts[vibeKanbanIdx + 1] === WORKTREES_DIR) {
      return parts[parts.length - 1];
    }
    const conductorIdx = parts.indexOf(CONDUCTOR_DIR);
    if (conductorIdx >= 0 && parts[conductorIdx + 1] === WORKSPACES_DIR) {
      if (parts[conductorIdx + 2]) {
        return parts[conductorIdx + 2];
      }
    }
    const autoClaudeIdx = parts.indexOf(AUTO_CLAUDE_DIR);
    if (autoClaudeIdx > 0 && parts[autoClaudeIdx + 1] === WORKTREES_DIR) {
      return parts[autoClaudeIdx - 1];
    }
    const twentyFirstIdx = parts.indexOf(TWENTYFIRST_DIR);
    if (twentyFirstIdx > 0 && parts[twentyFirstIdx + 1] === WORKTREES_DIR) {
      return parts[twentyFirstIdx - 1];
    }
    const claudeWorktreesIdx = parts.indexOf(CLAUDE_WORKTREES_DIR);
    if (claudeWorktreesIdx >= 0 && parts[claudeWorktreesIdx + 1]) {
      return parts[claudeWorktreesIdx + 1];
    }
    const ccswitchIdx = parts.indexOf(CCSWITCH_DIR);
    if (ccswitchIdx >= 0 && parts[ccswitchIdx + 1] === WORKTREES_DIR) {
      if (parts[ccswitchIdx + 2]) {
        return parts[ccswitchIdx + 2];
      }
    }
    return parts[parts.length - 1];
  }
  /**
   * Determine if a path is a worktree (vs main repo).
   * Worktrees have a .git file, main repos have a .git directory.
   * Uses path heuristics if filesystem is not available (for deleted worktrees).
   */
  async isWorktree(projectPath) {
    const parts = projectPath.split(path.sep).filter(Boolean);
    if (parts.includes(CURSOR_DIR) && parts.includes(WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(VIBE_KANBAN_DIR) && parts.includes(WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(AUTO_CLAUDE_DIR) && parts.includes(WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(TWENTYFIRST_DIR) && parts.includes(WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(CLAUDE_WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(CCSWITCH_DIR) && parts.includes(WORKTREES_DIR)) {
      return true;
    }
    if (parts.includes(CONDUCTOR_DIR) && parts.includes(WORKSPACES_DIR)) {
      const conductorIdx = parts.indexOf(CONDUCTOR_DIR);
      if (conductorIdx >= 0 && parts.length > conductorIdx + 3) {
        return true;
      }
    }
    try {
      const gitInfo = await this.findGitPath(projectPath);
      if (gitInfo) {
        return gitInfo.stats.isFile();
      }
    } catch {
    }
    return false;
  }
  /**
   * Extract the main .git directory path from a worktree's gitdir.
   *
   * @param worktreeGitDir - Path like "/path/to/main/.git/worktrees/<name>"
   * @returns Path to main .git directory like "/path/to/main/.git"
   */
  extractMainGitDir(worktreeGitDir) {
    const parts = worktreeGitDir.split(path.sep);
    const worktreesIndex = parts.lastIndexOf(WORKTREES_DIR);
    if (worktreesIndex > 0) {
      return parts.slice(0, worktreesIndex).join(path.sep);
    }
    const gitIndex = worktreeGitDir.lastIndexOf(".git");
    if (gitIndex > 0) {
      return worktreeGitDir.substring(0, gitIndex + 4);
    }
    return worktreeGitDir;
  }
  /**
   * Get git remote URL from a repository's config file.
   *
   * @param gitDir - Path to the .git directory
   * @returns Remote URL or null if not found
   */
  async getRemoteUrl(gitDir) {
    try {
      const configPath = path.join(gitDir, "config");
      try {
        await fs.promises.access(configPath);
      } catch {
        return null;
      }
      const configContent = await fs.promises.readFile(configPath, "utf-8");
      const lines = configContent.split(/\r?\n/);
      let inOriginRemote = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^\[remote\s+"origin"\]$/.exec(trimmed)) {
          inOriginRemote = true;
          continue;
        }
        if (trimmed.startsWith("[") && inOriginRemote) {
          break;
        }
        if (inOriginRemote && trimmed.startsWith("url")) {
          const urlMatch = /^url\s*=\s*(\S[^\r\n]*)$/.exec(trimmed);
          if (urlMatch) {
            return urlMatch[1].trim();
          }
        }
      }
      return null;
    } catch (error) {
      logger$2.error(`Error reading git config at ${gitDir}:`, error);
      return null;
    }
  }
  /**
   * Generate consistent repository ID.
   * Uses the LOCAL DIRECTORY NAME as the primary identifier to ensure consistent grouping
   * across filesystem-based and path-based resolution.
   *
   * IMPORTANT: We prioritize local directory name over remote URL repo name because:
   * 1. Path-based resolution (for deleted worktrees) can only use directory names
   * 2. Users may clone repos with different local names than remote names
   * 3. We need consistent grouping regardless of whether filesystem exists
   *
   * @param _remoteUrl - Git remote URL (unused, kept for API compatibility)
   * @param mainGitDirOrName - Path to main .git directory, or repo name for path-based resolution
   * @returns Consistent hash-based ID
   */
  generateRepoId(remoteUrl, mainGitDirOrName) {
    let identity;
    if (mainGitDirOrName.includes(path.sep) || mainGitDirOrName.includes("/")) {
      if (remoteUrl) {
        const parentDir = path.dirname(mainGitDirOrName);
        identity = path.basename(parentDir);
      } else {
        identity = mainGitDirOrName.endsWith(".git") ? path.dirname(mainGitDirOrName) : mainGitDirOrName;
      }
    } else {
      identity = mainGitDirOrName;
    }
    const normalized = identity.toLowerCase().trim();
    const hash = crypto.createHash("sha256").update(normalized).digest("hex");
    return hash.substring(0, 12);
  }
  /**
   * Extract repository name from git directory path.
   * Always uses the LOCAL directory name for consistency with path-based resolution.
   *
   * @param _remoteUrl - Git remote URL (unused, kept for API compatibility)
   * @param mainGitDir - Path to main .git directory
   * @returns Repository name for display
   */
  extractRepoName(_remoteUrl, mainGitDir) {
    const parentDir = path.dirname(mainGitDir);
    return path.basename(parentDir);
  }
  /**
   * Get the git branch for a worktree.
   *
   * @param projectPath - The filesystem path to check
   * @returns Branch name or null
   */
  async getBranch(projectPath) {
    try {
      const gitInfo = await this.findGitPath(projectPath);
      if (!gitInfo) return null;
      const { repoRoot, gitPath, stats } = gitInfo;
      let headPath;
      if (stats.isFile()) {
        const gitFileContent = (await fs.promises.readFile(gitPath, "utf-8")).trim();
        const gitDirMatch = /^gitdir:\s*(\S[^\r\n]*)$/.exec(gitFileContent);
        if (!gitDirMatch) {
          return null;
        }
        let worktreeGitDir = gitDirMatch[1].trim();
        if (!path.isAbsolute(worktreeGitDir)) {
          worktreeGitDir = path.resolve(repoRoot, worktreeGitDir);
        }
        headPath = path.join(worktreeGitDir, "HEAD");
      } else {
        headPath = path.join(gitPath, "HEAD");
      }
      try {
        await fs.promises.access(headPath);
      } catch {
        return null;
      }
      const headContent = (await fs.promises.readFile(headPath, "utf-8")).trim();
      const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(headContent);
      if (refMatch) {
        return refMatch[1];
      }
      return "detached HEAD";
    } catch (error) {
      logger$2.error(`Error reading git branch for ${projectPath}:`, error);
      return null;
    }
  }
  /**
   * Detect the worktree source based on path patterns.
   * This method works purely on path patterns and does NOT require filesystem access,
   * ensuring detection works even for deleted worktrees.
   *
   * Supported patterns:
   * - vibe-kanban: /tmp/vibe-kanban/worktrees/{issue-branch}/{repo}
   * - conductor: /Users/.../conductor/workspaces/{repo}/{workspace}
   * - auto-claude: /Users/.../.auto-claude/worktrees/tasks/{task-id}
   * - 21st: /Users/.../.21st/worktrees/{id}/{name}
   * - claude-desktop: /Users/.../.claude-worktrees/{repo}/{name}
   * - ccswitch: /Users/.../.ccswitch/worktrees/{repo}/{name}
   * - git: Standard git worktree (fallback if none of the above match)
   * - unknown: Non-git or undetectable
   *
   * @param projectPath - The filesystem path to check
   * @returns WorktreeSource identifier
   */
  async detectWorktreeSource(projectPath) {
    const parts = projectPath.split(path.sep).filter(Boolean);
    if (parts.includes(VIBE_KANBAN_DIR) && parts.includes(WORKTREES_DIR)) {
      return "vibe-kanban";
    }
    if (parts.includes(CONDUCTOR_DIR) && parts.includes(WORKSPACES_DIR)) {
      return "conductor";
    }
    if (parts.includes(AUTO_CLAUDE_DIR) && parts.includes(WORKTREES_DIR)) {
      return "auto-claude";
    }
    if (parts.includes(TWENTYFIRST_DIR) && parts.includes(WORKTREES_DIR)) {
      return "21st";
    }
    if (parts.includes(CLAUDE_WORKTREES_DIR)) {
      return "claude-desktop";
    }
    if (parts.includes(CCSWITCH_DIR) && parts.includes(WORKTREES_DIR)) {
      return "ccswitch";
    }
    try {
      const gitInfo = await this.findGitPath(projectPath);
      if (gitInfo) {
        return "git";
      }
    } catch {
    }
    return "git";
  }
  /**
   * Get the display name for a worktree based on its source.
   * Extracts the meaningful identifier from the path based on the pattern.
   *
   * @param projectPath - The filesystem path
   * @param source - The detected worktree source
   * @param branch - The git branch (if available)
   * @param isMainWorktree - Whether this is the main worktree
   * @returns Display name for the worktree
   */
  async getWorktreeDisplayName(projectPath, source, branch, isMainWorktree) {
    const parts = projectPath.split(path.sep).filter(Boolean);
    switch (source) {
      case "vibe-kanban": {
        const worktreesIdx = parts.indexOf(WORKTREES_DIR);
        if (worktreesIdx >= 0 && parts[worktreesIdx + 1]) {
          return parts[worktreesIdx + 1];
        }
        break;
      }
      case "conductor": {
        const workspacesIdx = parts.indexOf(WORKSPACES_DIR);
        if (workspacesIdx >= 0 && parts[workspacesIdx + 2]) {
          return parts[workspacesIdx + 2];
        }
        break;
      }
      case "auto-claude": {
        const tasksIdx = parts.indexOf(TASKS_DIR);
        if (tasksIdx >= 0 && parts[tasksIdx + 1]) {
          return parts[tasksIdx + 1];
        }
        return parts[parts.length - 1];
      }
      case "21st": {
        const lastPart = parts[parts.length - 1];
        const bracketStart = lastPart.indexOf("[");
        const bracketEnd = lastPart.indexOf("]", bracketStart);
        if (bracketStart !== -1 && bracketEnd !== -1 && bracketEnd > bracketStart + 1) {
          return lastPart.slice(bracketStart + 1, bracketEnd);
        }
        return lastPart;
      }
      case "claude-desktop": {
        const claudeWorktreesIdx = parts.indexOf(CLAUDE_WORKTREES_DIR);
        if (claudeWorktreesIdx >= 0 && parts[claudeWorktreesIdx + 2]) {
          return parts[claudeWorktreesIdx + 2];
        }
        break;
      }
      case "ccswitch": {
        const ccswitchWorktreesIdx = parts.indexOf(CCSWITCH_DIR);
        if (ccswitchWorktreesIdx >= 0) {
          const worktreesIdx = parts.indexOf(WORKTREES_DIR, ccswitchWorktreesIdx);
          if (worktreesIdx >= 0 && parts[worktreesIdx + 2]) {
            return parts[worktreesIdx + 2];
          }
        }
        break;
      }
      case "git":
        if (isMainWorktree) {
          return branch ?? "main";
        }
        return await this.getGitWorktreeName(projectPath) ?? branch ?? parts[parts.length - 1];
      case "unknown":
      default:
        return parts[parts.length - 1] ?? "unknown";
    }
    return branch ?? parts[parts.length - 1] ?? "unknown";
  }
  /**
   * Get the worktree name from git's internal tracking.
   * Reads .git file to find the worktree name in .git/worktrees/{name}
   *
   * @param projectPath - The filesystem path
   * @returns Worktree name or null
   */
  async getGitWorktreeName(projectPath) {
    try {
      const gitInfo = await this.findGitPath(projectPath);
      if (!gitInfo) return null;
      if (!gitInfo.stats.isFile()) return null;
      const { repoRoot, gitPath } = gitInfo;
      const content = await fs.promises.readFile(gitPath, "utf-8");
      const match = /gitdir:\s*(\S[^\r\n]*)/.exec(content);
      if (!match) return null;
      let worktreeGitDir = match[1].trim();
      if (!path.isAbsolute(worktreeGitDir)) {
        worktreeGitDir = path.resolve(repoRoot, worktreeGitDir);
      }
      const gitdirParts = worktreeGitDir.split(path.sep);
      const worktreesIdx = gitdirParts.lastIndexOf(WORKTREES_DIR);
      if (worktreesIdx >= 0 && gitdirParts[worktreesIdx + 1]) {
        return gitdirParts[worktreesIdx + 1];
      }
      return null;
    } catch {
      return null;
    }
  }
}
const gitIdentityResolver = new GitIdentityResolver();
class WorktreeGrouper {
  constructor(projectsDir, fsProvider) {
    this.projectsDir = projectsDir;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
  }
  /**
   * Groups projects by git repository.
   * Projects belonging to the same git repository (main repo + worktrees)
   * are grouped together under a single RepositoryGroup.
   * Non-git projects are represented as single-worktree groups.
   *
   * Sessions are filtered to exclude noise-only sessions, so counts
   * accurately reflect visible sessions in the UI.
   *
   * @param projects - List of projects to group
   * @returns Promise resolving to RepositoryGroups sorted by most recent activity
   */
  async groupByRepository(projects) {
    if (projects.length === 0) {
      return [];
    }
    const projectIdentities = /* @__PURE__ */ new Map();
    const projectBranches = /* @__PURE__ */ new Map();
    await Promise.all(
      projects.map(async (project) => {
        const identity = await gitIdentityResolver.resolveIdentity(project.path);
        projectIdentities.set(project.id, identity);
        const branch = await gitIdentityResolver.getBranch(project.path);
        projectBranches.set(project.id, branch);
      })
    );
    const projectFilteredSessions = /* @__PURE__ */ new Map();
    const shouldFilterNoise = process.env.CLAUDE_DEVTOOLS_STRICT_SESSION_FILTER === "1";
    await Promise.all(
      projects.map(async (project) => {
        const baseDir = extractBaseDir(project.id);
        const projectPath = path.join(this.projectsDir, baseDir);
        const sessionFilter = subprojectRegistry.getSessionFilter(project.id);
        const filteredSessions = [];
        for (const sessionId of project.sessions) {
          if (sessionFilter && !sessionFilter.has(sessionId)) {
            continue;
          }
          if (!shouldFilterNoise) {
            filteredSessions.push(sessionId);
            continue;
          }
          const sessionPath = path.join(projectPath, `${sessionId}.jsonl`);
          if (await SessionContentFilter.hasNonNoiseMessages(sessionPath, this.fsProvider)) {
            filteredSessions.push(sessionId);
          }
        }
        projectFilteredSessions.set(project.id, filteredSessions);
      })
    );
    const repoGroups = /* @__PURE__ */ new Map();
    for (const project of projects) {
      const identity = projectIdentities.get(project.id) ?? null;
      const branch = projectBranches.get(project.id) ?? null;
      const groupId = identity?.id ?? project.id;
      if (!repoGroups.has(groupId)) {
        repoGroups.set(groupId, {
          identity,
          projects: [],
          branches: /* @__PURE__ */ new Map()
        });
      }
      const group = repoGroups.get(groupId);
      group.projects.push(project);
      group.branches.set(project.id, branch);
    }
    const repositoryGroups = [];
    for (const [groupId, group] of repoGroups) {
      const worktrees = await Promise.all(group.projects.map(async (project) => {
        const branch = group.branches.get(project.id) ?? null;
        const isMainWorktree = !await gitIdentityResolver.isWorktree(project.path);
        const filteredSessions = projectFilteredSessions.get(project.id) ?? [];
        const source = await gitIdentityResolver.detectWorktreeSource(project.path);
        const displayName = await gitIdentityResolver.getWorktreeDisplayName(
          project.path,
          source,
          branch,
          isMainWorktree
        );
        return {
          id: project.id,
          path: project.path,
          name: displayName,
          gitBranch: branch ?? void 0,
          isMainWorktree,
          source,
          sessions: filteredSessions,
          createdAt: project.createdAt,
          mostRecentSession: project.mostRecentSession
        };
      }));
      const nonEmptyWorktrees = worktrees.filter((wt) => wt.sessions.length > 0);
      if (nonEmptyWorktrees.length === 0) {
        continue;
      }
      nonEmptyWorktrees.sort((a, b) => {
        if (a.isMainWorktree && !b.isMainWorktree) return -1;
        if (!a.isMainWorktree && b.isMainWorktree) return 1;
        return (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0);
      });
      const totalSessions = nonEmptyWorktrees.reduce((sum, wt) => sum + wt.sessions.length, 0);
      const mostRecentSession = Math.max(
        ...nonEmptyWorktrees.map((wt) => wt.mostRecentSession ?? 0)
      );
      repositoryGroups.push({
        id: groupId,
        identity: group.identity,
        worktrees: nonEmptyWorktrees,
        name: group.identity?.name ?? group.projects[0].name,
        mostRecentSession: mostRecentSession > 0 ? mostRecentSession : void 0,
        totalSessions
      });
    }
    repositoryGroups.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
    return repositoryGroups;
  }
  /**
   * Lists sessions for a specific worktree.
   * This is a convenience method that returns the worktree ID.
   *
   * @param worktreeId - The worktree ID (same as project ID)
   * @returns The worktree ID for delegation to listSessions
   */
  getWorktreeProjectId(worktreeId) {
    return worktreeId;
  }
}
const logger$1 = createLogger("Discovery:ProjectScanner");
const SEARCH_PROJECT_CACHE_TTL_MS = 3e4;
class ProjectScanner {
  constructor(projectsDir, todosDir, fsProvider) {
    this.contentPresenceCache = /* @__PURE__ */ new Map();
    this.sessionMetadataCache = /* @__PURE__ */ new Map();
    this.searchProjectCache = null;
    this.projectsDir = projectsDir ?? getProjectsBasePath();
    this.todosDir = todosDir ?? getTodosBasePath();
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
    this.sessionContentFilter = SessionContentFilter;
    this.worktreeGrouper = new WorktreeGrouper(this.projectsDir, this.fsProvider);
    this.subagentLocator = new SubagentLocator(this.projectsDir, this.fsProvider);
    this.sessionSearcher = new SessionSearcher(this.projectsDir, this.fsProvider);
    this.projectPathResolver = new ProjectPathResolver(this.projectsDir, this.fsProvider);
  }
  // ===========================================================================
  // Project Scanning
  // ===========================================================================
  /**
   * Scans the projects directory and returns a list of all projects.
   * @returns Promise resolving to projects sorted by most recent activity
   */
  async scan() {
    const startedAt = Date.now();
    try {
      if (!await this.fsProvider.exists(this.projectsDir)) {
        logger$1.warn(`Projects directory does not exist: ${this.projectsDir}`);
        return [];
      }
      subprojectRegistry.clear();
      const entries = await this.fsProvider.readdir(this.projectsDir);
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
      );
      const projectArrays = await this.collectFulfilledInBatches(
        projectDirs,
        this.fsProvider.type === "ssh" ? 8 : 24,
        async (dir) => this.scanProject(dir.name)
      );
      const validProjects = projectArrays.flat();
      validProjects.sort((a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0));
      if (this.fsProvider.type === "ssh") {
        logger$1.debug(
          `SSH scan completed: ${validProjects.length} projects in ${Date.now() - startedAt}ms`
        );
      }
      return validProjects;
    } catch (error) {
      logger$1.error("Error scanning projects directory:", error);
      return [];
    }
  }
  // ===========================================================================
  // Repository Grouping (Worktree Support)
  // ===========================================================================
  /**
   * Scans projects and groups them by git repository.
   * Projects belonging to the same git repository (main repo + worktrees)
   * are grouped together under a single RepositoryGroup.
   * Non-git projects are represented as single-worktree groups.
   *
   * Sessions are filtered to exclude noise-only sessions, so counts
   * accurately reflect visible sessions in the UI.
   *
   * @returns Promise resolving to RepositoryGroups sorted by most recent activity
   */
  async scanWithWorktreeGrouping() {
    try {
      const projects = await this.scan();
      if (projects.length === 0) {
        return [];
      }
      return this.worktreeGrouper.groupByRepository(projects);
    } catch (error) {
      logger$1.error("Error scanning with worktree grouping:", error);
      return [];
    }
  }
  /**
   * Lists sessions for a specific worktree within a repository group.
   * This is a convenience method that delegates to listSessions since
   * worktree.id is the same as project.id.
   *
   * @param worktreeId - The worktree ID (same as project ID)
   */
  async listWorktreeSessions(worktreeId) {
    return this.listSessions(worktreeId);
  }
  // ===========================================================================
  // Project Scanning (continued)
  // ===========================================================================
  /**
   * Scans a single project directory and returns project metadata.
   * If sessions have different cwd values, splits into multiple projects.
   */
  async scanProject(encodedName) {
    try {
      const projectPath = path.join(this.projectsDir, encodedName);
      const entries = await this.fsProvider.readdir(projectPath);
      const sessionFiles = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".jsonl")
      );
      if (sessionFiles.length === 0) {
        return [];
      }
      const shouldSplitByCwd = this.fsProvider.type !== "ssh";
      const sessionInfos = await this.collectFulfilledInBatches(
        sessionFiles,
        this.fsProvider.type === "ssh" ? 32 : 128,
        async (file) => {
          const filePath = path.join(projectPath, file.name);
          const { mtimeMs, birthtimeMs } = await this.resolveFileDetails(file, filePath);
          let cwd = null;
          if (shouldSplitByCwd) {
            try {
              cwd = await extractCwd(filePath, this.fsProvider);
            } catch {
            }
          }
          return {
            sessionId: extractSessionId(file.name),
            filePath,
            mtimeMs,
            birthtimeMs,
            cwd
          };
        }
      );
      if (sessionInfos.length === 0) {
        return [];
      }
      const cwdGroups = /* @__PURE__ */ new Map();
      const baseName = extractProjectName(encodedName);
      const decodedFallback = baseName;
      for (const info of sessionInfos) {
        const key = shouldSplitByCwd ? info.cwd ?? `__decoded__${decodedFallback}` : encodedName;
        const group = cwdGroups.get(key) ?? [];
        group.push(info);
        cwdGroups.set(key, group);
      }
      const realCwdKeys = [...cwdGroups.keys()].filter((k) => !k.startsWith("__decoded__"));
      if (realCwdKeys.length <= 1) {
        const allSessionIds = sessionInfos.map((s) => s.sessionId);
        let mostRecentSession;
        let createdAt = Date.now();
        for (const info of sessionInfos) {
          if (!mostRecentSession || info.mtimeMs > mostRecentSession) {
            mostRecentSession = info.mtimeMs;
          }
          if (info.birthtimeMs < createdAt) {
            createdAt = info.birthtimeMs;
          }
        }
        const sessionPaths = sessionInfos.map((s) => s.filePath);
        const actualPath = await this.projectPathResolver.resolveProjectPath(encodedName, {
          sessionPaths
        });
        return [
          {
            id: encodedName,
            path: actualPath,
            name: baseName,
            sessions: allSessionIds,
            createdAt: Math.floor(createdAt),
            mostRecentSession: mostRecentSession ? Math.floor(mostRecentSession) : void 0
          }
        ];
      }
      const projects = [];
      const cwdKeys = [...cwdGroups.keys()].filter((k) => !k.startsWith("__decoded__"));
      const rootCwd = cwdKeys.reduce(
        (shortest, cwd) => cwd.length <= shortest.length ? cwd : shortest,
        cwdKeys[0] ?? ""
      );
      for (const [cwdKey, sessions] of cwdGroups) {
        const isDecodedFallback = cwdKey.startsWith("__decoded__");
        const actualCwd = isDecodedFallback ? null : cwdKey;
        const sessionIds = sessions.map((s) => s.sessionId);
        const compositeId = subprojectRegistry.register(
          encodedName,
          actualCwd ?? decodedFallback,
          sessionIds
        );
        let mostRecentSession;
        let createdAt = Date.now();
        for (const info of sessions) {
          if (!mostRecentSession || info.mtimeMs > mostRecentSession) {
            mostRecentSession = info.mtimeMs;
          }
          if (info.birthtimeMs < createdAt) {
            createdAt = info.birthtimeMs;
          }
        }
        let displayName;
        if (!actualCwd || actualCwd === rootCwd) {
          displayName = baseName;
        } else {
          const lastSegment = path.basename(actualCwd);
          displayName = `${baseName} (${lastSegment})`;
        }
        projects.push({
          id: compositeId,
          path: actualCwd ?? decodedFallback,
          name: displayName,
          sessions: sessionIds,
          createdAt: Math.floor(createdAt),
          mostRecentSession: mostRecentSession ? Math.floor(mostRecentSession) : void 0
        });
      }
      return projects;
    } catch (error) {
      logger$1.error(`Error scanning project ${encodedName}:`, error);
      return [];
    }
  }
  /**
   * Gets details for a specific project by ID.
   * Handles composite IDs by scanning the base directory and finding the matching subproject.
   */
  async getProject(projectId) {
    const baseDir = extractBaseDir(projectId);
    const projectPath = path.join(this.projectsDir, baseDir);
    if (!await this.fsProvider.exists(projectPath)) {
      return null;
    }
    if (subprojectRegistry.isComposite(projectId)) {
      const projects2 = await this.scanProject(baseDir);
      return projects2.find((p) => p.id === projectId) ?? null;
    }
    const projects = await this.scanProject(baseDir);
    return projects.find((p) => p.id === projectId) ?? projects[0] ?? null;
  }
  // ===========================================================================
  // Session Listing
  // ===========================================================================
  /**
   * Lists all sessions for a given project with metadata.
   * Filters out sessions that contain only noise messages.
   */
  async listSessions(projectId) {
    try {
      const baseDir = extractBaseDir(projectId);
      const projectPath = path.join(this.projectsDir, baseDir);
      const sessionFilter = await this.getSessionFilterForProject(projectId);
      const shouldFilterNoise = this.fsProvider.type !== "ssh";
      const metadataLevel = "light";
      if (!await this.fsProvider.exists(projectPath)) {
        return [];
      }
      const entries = await this.fsProvider.readdir(projectPath);
      let sessionFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      if (sessionFilter) {
        sessionFiles = sessionFiles.filter((f) => sessionFilter.has(extractSessionId(f.name)));
      }
      const sessionPaths = sessionFiles.map((file) => path.join(projectPath, file.name));
      const decodedPath = await this.resolveProjectPathForId(projectId, sessionPaths);
      const sessions = await Promise.all(
        sessionFiles.map(async (file) => {
          const sessionId = extractSessionId(file.name);
          const filePath = path.join(projectPath, file.name);
          const fileDetails = await this.resolveFileDetails(file, filePath);
          const prefetchedMtimeMs = fileDetails.mtimeMs;
          const prefetchedSize = fileDetails.size;
          const prefetchedBirthtimeMs = fileDetails.birthtimeMs;
          if (shouldFilterNoise) {
            const hasContent = await this.hasDisplayableContent(
              filePath,
              prefetchedMtimeMs,
              prefetchedSize
            );
            if (!hasContent) {
              return null;
            }
          }
          return this.buildSessionForListing(
            metadataLevel,
            projectId,
            sessionId,
            filePath,
            decodedPath,
            prefetchedMtimeMs,
            prefetchedSize,
            prefetchedBirthtimeMs
          );
        })
      );
      const validSessions = sessions.filter((s) => s !== null);
      validSessions.sort((a, b) => b.createdAt - a.createdAt);
      return validSessions;
    } catch (error) {
      logger$1.error(`Error listing sessions for project ${projectId}:`, error);
      return [];
    }
  }
  /**
   * Lists sessions for a project with cursor-based pagination.
   * Efficiently fetches only the sessions needed for the current page.
   *
   * @param projectId - The project ID to list sessions for
   * @param cursor - Base64-encoded cursor from previous page (null for first page)
   * @param limit - Number of sessions to return (default 20)
   * @returns Paginated result with sessions, cursor, and metadata
   */
  async listSessionsPaginated(projectId, cursor, limit = 20, options) {
    const startedAt = Date.now();
    try {
      const includeTotalCount = options?.includeTotalCount ?? false;
      const prefilterAll = options?.prefilterAll ?? false;
      const baseDir = extractBaseDir(projectId);
      const projectPath = path.join(this.projectsDir, baseDir);
      const sessionFilter = await this.getSessionFilterForProject(projectId);
      const metadataLevel = options?.metadataLevel ?? (this.fsProvider.type === "ssh" ? "light" : "deep");
      const shouldFilterNoise = this.fsProvider.type !== "ssh" && metadataLevel === "deep";
      if (!await this.fsProvider.exists(projectPath)) {
        return { sessions: [], nextCursor: null, hasMore: false, totalCount: 0 };
      }
      const entries = await this.fsProvider.readdir(projectPath);
      let sessionFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      if (sessionFilter) {
        sessionFiles = sessionFiles.filter((f) => sessionFilter.has(extractSessionId(f.name)));
      }
      const fileInfos = await this.collectFulfilledInBatches(
        sessionFiles,
        this.fsProvider.type === "ssh" ? 48 : 200,
        async (file) => {
          const filePath = path.join(projectPath, file.name);
          const fileDetails = await this.resolveFileDetails(file, filePath);
          return {
            name: file.name,
            sessionId: extractSessionId(file.name),
            timestamp: fileDetails.mtimeMs,
            filePath,
            mtimeMs: fileDetails.mtimeMs,
            size: fileDetails.size,
            birthtimeMs: fileDetails.birthtimeMs
          };
        }
      );
      fileInfos.sort((a, b) => {
        if (b.timestamp !== a.timestamp) {
          return b.timestamp - a.timestamp;
        }
        return a.sessionId.localeCompare(b.sessionId);
      });
      let validSessionIds = null;
      let totalCount = 0;
      if (prefilterAll && shouldFilterNoise && metadataLevel === "deep") {
        const contentResults = await Promise.allSettled(
          fileInfos.map(async (fileInfo) => ({
            sessionId: fileInfo.sessionId,
            hasContent: await this.hasDisplayableContent(
              fileInfo.filePath,
              fileInfo.mtimeMs,
              fileInfo.size
            )
          }))
        );
        validSessionIds = /* @__PURE__ */ new Set();
        for (const result2 of contentResults) {
          if (result2.status === "fulfilled" && result2.value.hasContent) {
            validSessionIds.add(result2.value.sessionId);
          }
        }
        totalCount = validSessionIds.size;
      }
      let startIndex = 0;
      if (cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(cursor, "base64").toString("utf8")
          );
          startIndex = fileInfos.findIndex((info) => {
            if (info.timestamp < decoded.timestamp) return true;
            if (info.timestamp === decoded.timestamp && info.sessionId > decoded.sessionId)
              return true;
            return false;
          });
          if (startIndex === -1) startIndex = fileInfos.length;
        } catch {
          startIndex = 0;
        }
      }
      const decodedPath = await this.resolveProjectPathForId(
        projectId,
        fileInfos.map((fileInfo) => fileInfo.filePath)
      );
      const sessions = [];
      let scannedCandidates = 0;
      const BATCH_SIZE = limit + 1;
      let batchStart = startIndex;
      while (sessions.length < limit + 1 && batchStart < fileInfos.length) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE * 2, fileInfos.length);
        const batch = fileInfos.slice(batchStart, batchEnd);
        scannedCandidates += batch.length;
        let contentBatch;
        if (validSessionIds) {
          contentBatch = batch.map((fileInfo) => ({
            fileInfo,
            hasContent: validSessionIds.has(fileInfo.sessionId)
          }));
        } else if (!shouldFilterNoise) {
          contentBatch = batch.map((fileInfo) => ({ fileInfo, hasContent: true }));
        } else {
          const contentResults = await Promise.allSettled(
            batch.map(async (fileInfo) => ({
              fileInfo,
              hasContent: await this.hasDisplayableContent(
                fileInfo.filePath,
                fileInfo.mtimeMs,
                fileInfo.size
              )
            }))
          );
          contentBatch = contentResults.filter(
            (r) => r.status === "fulfilled"
          ).map((r) => r.value);
        }
        const withContent = contentBatch.filter((c) => c.hasContent);
        const needed = limit + 1 - sessions.length;
        const toBuild = withContent.slice(0, needed);
        const builtSessions = await this.collectFulfilledInBatches(
          toBuild,
          this.fsProvider.type === "ssh" ? 4 : 16,
          async ({ fileInfo }) => this.buildSessionForListing(
            metadataLevel,
            projectId,
            fileInfo.sessionId,
            fileInfo.filePath,
            decodedPath,
            fileInfo.mtimeMs,
            fileInfo.size,
            fileInfo.birthtimeMs
          )
        );
        sessions.push(...builtSessions);
        batchStart = batchEnd;
      }
      let nextCursor = null;
      const hasMore = sessions.length > limit || startIndex + scannedCandidates < fileInfos.length;
      const pageSessions = hasMore ? sessions.slice(0, limit) : sessions;
      if (!includeTotalCount) {
        totalCount = pageSessions.length + (hasMore ? 1 : 0);
      }
      if (pageSessions.length > 0 && hasMore) {
        const lastSession = pageSessions[pageSessions.length - 1];
        const lastFileInfo = fileInfos.find((f) => f.sessionId === lastSession.id);
        if (lastFileInfo) {
          const cursorData = {
            timestamp: lastFileInfo.timestamp,
            sessionId: lastFileInfo.sessionId
          };
          nextCursor = Buffer.from(JSON.stringify(cursorData)).toString("base64");
        }
      }
      const result = {
        sessions: pageSessions,
        nextCursor,
        hasMore: nextCursor !== null,
        totalCount
      };
      if (this.fsProvider.type === "ssh") {
        logger$1.debug(
          `SSH listSessionsPaginated(${projectId}) returned ${result.sessions.length} sessions in ${Date.now() - startedAt}ms (hasMore=${result.hasMore})`
        );
      }
      return result;
    } catch (error) {
      logger$1.error(`Error listing paginated sessions for project ${projectId}:`, error);
      return { sessions: [], nextCursor: null, hasMore: false, totalCount: 0 };
    }
  }
  /**
   * Build session metadata from a session file.
   */
  async buildSessionMetadata(projectId, sessionId, filePath, projectPath, prefetchedMtimeMs, prefetchedSize, prefetchedBirthtimeMs) {
    const hasPrefetchedCoreStats = typeof prefetchedMtimeMs === "number" && typeof prefetchedSize === "number";
    const needsBirthtimeStat = typeof prefetchedBirthtimeMs !== "number";
    const stats = hasPrefetchedCoreStats && !needsBirthtimeStat ? null : await this.fsProvider.stat(filePath);
    const effectiveMtime = prefetchedMtimeMs ?? stats?.mtimeMs ?? Date.now();
    const effectiveSize = prefetchedSize ?? stats?.size ?? -1;
    const birthtimeMs = prefetchedBirthtimeMs ?? stats?.birthtimeMs ?? effectiveMtime;
    const cachedMetadata = this.sessionMetadataCache.get(filePath);
    const metadata = cachedMetadata?.mtimeMs === effectiveMtime && cachedMetadata.size === effectiveSize ? cachedMetadata.metadata : await analyzeSessionFileMetadata(filePath, this.fsProvider);
    if (cachedMetadata?.mtimeMs !== effectiveMtime || cachedMetadata.size !== effectiveSize) {
      this.sessionMetadataCache.set(filePath, {
        mtimeMs: effectiveMtime,
        size: effectiveSize,
        metadata
      });
    }
    const [hasSubagents, todoData] = await Promise.all([
      this.subagentLocator.hasSubagents(projectId, sessionId),
      this.loadTodoData(sessionId)
    ]);
    const metadataLevel = "deep";
    const firstMessageTimestampMs = this.parseTimestampMs(metadata.firstUserMessage?.timestamp);
    const createdAt = firstMessageTimestampMs !== null && Number.isFinite(firstMessageTimestampMs) ? firstMessageTimestampMs : birthtimeMs;
    const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1e3;
    const isOngoing = metadata.isOngoing && Date.now() - effectiveMtime < STALE_SESSION_THRESHOLD_MS;
    return {
      id: sessionId,
      projectId,
      projectPath,
      todoData,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(effectiveMtime),
      firstMessage: metadata.firstUserMessage?.text,
      name: metadata.name ?? void 0,
      messageTimestamp: metadata.firstUserMessage?.timestamp,
      hasSubagents,
      messageCount: metadata.messageCount,
      isOngoing,
      gitBranch: metadata.gitBranch ?? void 0,
      metadataLevel,
      contextConsumption: metadata.contextConsumption,
      compactionCount: metadata.compactionCount,
      phaseBreakdown: metadata.phaseBreakdown,
      totalTokens: metadata.totalTokens,
      turnCount: metadata.turnCount
    };
  }
  /**
   * Build a lightweight session record using filesystem metadata only.
   * Used as SSH fallback when deep parsing fails transiently.
   */
  async buildLightSessionMetadata(projectId, sessionId, filePath, projectPath, prefetchedMtimeMs, prefetchedSize, prefetchedBirthtimeMs) {
    const hasPrefetchedCoreStats = typeof prefetchedMtimeMs === "number" && typeof prefetchedSize === "number";
    const needsBirthtimeStat = typeof prefetchedBirthtimeMs !== "number";
    const stats = hasPrefetchedCoreStats && !needsBirthtimeStat ? null : await this.fsProvider.stat(filePath);
    const effectiveMtime = prefetchedMtimeMs ?? stats?.mtimeMs ?? Date.now();
    const effectiveSize = prefetchedSize ?? stats?.size ?? -1;
    const birthtimeMs = prefetchedBirthtimeMs ?? stats?.birthtimeMs ?? effectiveMtime;
    let metadata;
    const cachedMetadata = this.sessionMetadataCache.get(filePath);
    if (cachedMetadata?.mtimeMs === effectiveMtime && cachedMetadata.size === effectiveSize) {
      metadata = cachedMetadata.metadata;
    } else {
      try {
        metadata = await analyzeSessionFileMetadata(filePath, this.fsProvider);
        this.sessionMetadataCache.set(filePath, {
          mtimeMs: effectiveMtime,
          size: effectiveSize,
          metadata
        });
      } catch (error) {
        logger$1.debug(`Failed to analyze session metadata for ${filePath}:`, error);
        metadata = {
          firstUserMessage: null,
          messageCount: 0,
          isOngoing: false,
          gitBranch: null,
          totalTokens: 0,
          turnCount: 0,
          hasDisplayableContent: false
        };
      }
    }
    const metadataLevel = "light";
    const previewTimestampMs = this.parseTimestampMs(metadata.firstUserMessage?.timestamp);
    const createdAt = previewTimestampMs !== null && Number.isFinite(previewTimestampMs) ? previewTimestampMs : birthtimeMs;
    return {
      id: sessionId,
      projectId,
      projectPath,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(effectiveMtime),
      firstMessage: metadata.firstUserMessage?.text,
      name: metadata.name ?? void 0,
      messageTimestamp: metadata.firstUserMessage?.timestamp,
      hasSubagents: false,
      messageCount: metadata.messageCount,
      totalTokens: metadata.totalTokens,
      turnCount: metadata.turnCount,
      metadataLevel
    };
  }
  /**
   * Build session metadata according to requested listing depth.
   * In SSH mode, deep parse failures degrade gracefully to light metadata.
   */
  async buildSessionForListing(metadataLevel, projectId, sessionId, filePath, projectPath, prefetchedMtimeMs, prefetchedSize, prefetchedBirthtimeMs) {
    if (metadataLevel === "light") {
      return this.buildLightSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    }
    try {
      return await this.buildSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    } catch (error) {
      if (this.fsProvider.type !== "ssh") {
        throw error;
      }
      logger$1.debug(`SSH metadata parse failed for ${sessionId}, using light fallback`, error);
      return this.buildLightSessionMetadata(
        projectId,
        sessionId,
        filePath,
        projectPath,
        prefetchedMtimeMs,
        prefetchedSize,
        prefetchedBirthtimeMs
      );
    }
  }
  /**
   * Gets a single session's metadata.
   */
  async getSession(projectId, sessionId) {
    const filePath = this.getSessionPath(projectId, sessionId);
    if (!await this.fsProvider.exists(filePath)) {
      return null;
    }
    const metadataLevel = "deep";
    const decodedPath = await this.resolveProjectPathForId(projectId);
    return this.buildSessionForListing(metadataLevel, projectId, sessionId, filePath, decodedPath);
  }
  /**
   * Gets a single session's metadata with optional depth override.
   */
  async getSessionWithOptions(projectId, sessionId, options) {
    const filePath = this.getSessionPath(projectId, sessionId);
    if (!await this.fsProvider.exists(filePath)) {
      return null;
    }
    const metadataLevel = options?.metadataLevel ?? (this.fsProvider.type === "ssh" ? "light" : "deep");
    const decodedPath = await this.resolveProjectPathForId(projectId);
    return this.buildSessionForListing(metadataLevel, projectId, sessionId, filePath, decodedPath);
  }
  // ===========================================================================
  // Task List Data
  // ===========================================================================
  /**
   * Loads task list data for a session from ~/.claude/todos/{sessionId}.json
   */
  async loadTodoData(sessionId) {
    try {
      const todoPath = buildTodoPath(path.dirname(this.projectsDir), sessionId);
      if (!await this.fsProvider.exists(todoPath)) {
        return void 0;
      }
      const content = await this.fsProvider.readFile(todoPath);
      return JSON.parse(content);
    } catch (error) {
      logger$1.debug(`Failed to load task list data for session ${sessionId}:`, error);
      return void 0;
    }
  }
  // ===========================================================================
  // Path Helpers
  // ===========================================================================
  /**
   * Gets the path to the session JSONL file.
   */
  getSessionPath(projectId, sessionId) {
    return buildSessionPath(this.projectsDir, projectId, sessionId);
  }
  /**
   * Gets the path to the subagents directory.
   */
  getSubagentsPath(projectId, sessionId) {
    return buildSubagentsPath(this.projectsDir, projectId, sessionId);
  }
  /**
   * Lists all session file paths for a project.
   */
  async listSessionFiles(projectId) {
    try {
      const baseDir = extractBaseDir(projectId);
      const projectPath = path.join(this.projectsDir, baseDir);
      const sessionFilter = await this.getSessionFilterForProject(projectId);
      if (!await this.fsProvider.exists(projectPath)) {
        return [];
      }
      const entries = await this.fsProvider.readdir(projectPath);
      let files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      if (sessionFilter) {
        files = files.filter((entry) => sessionFilter.has(extractSessionId(entry.name)));
      }
      return files.map((entry) => path.join(projectPath, entry.name));
    } catch (error) {
      logger$1.error(`Error listing session files for project ${projectId}:`, error);
      return [];
    }
  }
  /**
   * Returns the session filter set for a project.
   * In local mode, composite IDs are refreshed from disk first so newly created
   * sessions are not hidden by stale registry entries.
   */
  async getSessionFilterForProject(projectId) {
    if (this.fsProvider.type === "local" && subprojectRegistry.isComposite(projectId)) {
      const baseDir = extractBaseDir(projectId);
      await this.scanProject(baseDir);
    }
    return subprojectRegistry.getSessionFilter(projectId);
  }
  // ===========================================================================
  // Subagent Detection (delegated to SubagentLocator)
  // ===========================================================================
  /**
   * Checks if a session has a subagents directory (async).
   */
  async hasSubagents(projectId, sessionId) {
    return this.subagentLocator.hasSubagents(projectId, sessionId);
  }
  /**
   * Lists all subagent files for a session from both NEW and OLD structures.
   * Returns NEW structure files first, then OLD structure files.
   */
  async listSubagentFiles(projectId, sessionId) {
    return this.subagentLocator.listSubagentFiles(projectId, sessionId);
  }
  // ===========================================================================
  // Utility Methods
  // ===========================================================================
  /**
   * Gets the base projects directory path.
   */
  getProjectsDir() {
    return this.projectsDir;
  }
  /**
   * Gets the base todos directory path.
   */
  getTodosDir() {
    return this.todosDir;
  }
  /**
   * Gets the FileSystemProvider instance used by this scanner.
   */
  getFileSystemProvider() {
    return this.fsProvider;
  }
  /**
   * Invalidate internal caches for a project.
   * Called by FileWatcher when session files change so stale cache entries
   * (e.g. sessions previously flagged as empty) are re-evaluated.
   */
  invalidateCachesForProject(projectId) {
    const decoded = decodeURIComponent(projectId);
    const prefix = path.join(this.projectsDir, decoded);
    for (const key of this.contentPresenceCache.keys()) {
      if (key.startsWith(prefix)) this.contentPresenceCache.delete(key);
    }
    for (const key of this.sessionMetadataCache.keys()) {
      if (key.startsWith(prefix)) this.sessionMetadataCache.delete(key);
    }
  }
  /**
   * Checks if the projects directory exists.
   */
  async projectsDirExists() {
    return this.fsProvider.exists(this.projectsDir);
  }
  // ===========================================================================
  // Search (delegated to SessionSearcher)
  // ===========================================================================
  /**
   * Searches sessions in a project for a query string.
   * Filters out noise messages and returns matching content.
   *
   * @param projectId - The project ID to search in
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 50)
   */
  async searchSessions(projectId, query, maxResults = 50) {
    return this.sessionSearcher.searchSessions(projectId, query, maxResults);
  }
  /**
   * Searches sessions across all projects for a query string.
   * Filters out noise messages and returns matching content.
   *
   * @param query - Search query string
   * @param maxResults - Maximum number of results to return (default 50)
   */
  async searchAllProjects(query, maxResults = 50) {
    const startedAt = Date.now();
    try {
      if (!query || query.trim().length === 0) {
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }
      let projects;
      if (this.searchProjectCache && Date.now() - this.searchProjectCache.timestamp < SEARCH_PROJECT_CACHE_TTL_MS) {
        projects = this.searchProjectCache.projects;
      } else {
        projects = await this.scan();
        this.searchProjectCache = { projects, timestamp: Date.now() };
      }
      if (projects.length === 0) {
        return { results: [], totalMatches: 0, sessionsSearched: 0, query };
      }
      const allResults = [];
      const searchBatchSize = this.fsProvider.type === "ssh" ? 2 : 8;
      for (let i = 0; i < projects.length; i += searchBatchSize) {
        const batch = projects.slice(i, i + searchBatchSize);
        const batchResults = await Promise.allSettled(
          batch.map((project) => this.sessionSearcher.searchSessions(project.id, query, maxResults))
        );
        for (const result of batchResults) {
          if (result.status === "fulfilled") {
            allResults.push(result.value);
          }
        }
        const totalMatches = allResults.reduce((sum, r) => sum + r.totalMatches, 0);
        if (totalMatches >= maxResults) {
          break;
        }
      }
      const mergedResults = allResults.flatMap((r) => r.results);
      const totalSessionsSearched = allResults.reduce((sum, r) => sum + r.sessionsSearched, 0);
      mergedResults.sort((a, b) => b.timestamp - a.timestamp);
      const limitedResults = mergedResults.slice(0, maxResults);
      logger$1.debug(
        `Global search completed: ${limitedResults.length} results from ${totalSessionsSearched} sessions across ${projects.length} projects in ${Date.now() - startedAt}ms`
      );
      return {
        results: limitedResults,
        totalMatches: limitedResults.length,
        sessionsSearched: totalSessionsSearched,
        query
      };
    } catch (error) {
      logger$1.error("Error searching all projects:", error);
      return { results: [], totalMatches: 0, sessionsSearched: 0, query };
    }
  }
  /**
   * Finds a session by its UUID across all projects.
   * Scans all project directories for a matching .jsonl file.
   *
   * @param sessionId - UUID of the session to find
   * @returns FindSessionByIdResult with projectId and session metadata if found
   */
  async findSessionById(sessionId) {
    try {
      const entries = await this.fsProvider.readdir(this.projectsDir).catch(() => []);
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
      );
      const batchSize = this.fsProvider.type === "ssh" ? 8 : 24;
      for (let i = 0; i < projectDirs.length; i += batchSize) {
        const batch = projectDirs.slice(i, i + batchSize);
        const settled = await Promise.allSettled(
          batch.map(async (dir) => {
            const sessionPath = buildSessionPath(this.projectsDir, dir.name, sessionId);
            return await this.fsProvider.exists(sessionPath) ? dir.name : null;
          })
        );
        for (const result of settled) {
          if (result.status === "fulfilled" && result.value) {
            const matchedProjectId = result.value;
            const session = await this.getSessionWithOptions(matchedProjectId, sessionId, {
              metadataLevel: "light"
            });
            if (session) {
              return { found: true, projectId: matchedProjectId, session };
            }
          }
        }
      }
      return { found: false };
    } catch (error) {
      logger$1.error(`Error finding session by ID ${sessionId}:`, error);
      return { found: false };
    }
  }
  /**
   * Finds sessions whose IDs contain the given fragment (case-insensitive).
   * Scans all project directories in parallel and returns matches sorted by recency.
   *
   * @param fragment - Partial session ID fragment (min 3 chars, hex-dash chars only)
   * @returns FindSessionsByPartialIdResult with matching sessions sorted by createdAt desc
   */
  async findSessionsByPartialId(fragment, maxResults = 50) {
    try {
      const lowerFragment = fragment.toLowerCase();
      const entries = await this.fsProvider.readdir(this.projectsDir).catch(() => []);
      const projectDirs = entries.filter(
        (entry) => entry.isDirectory() && isValidEncodedPath(entry.name)
      );
      const perProjectMatches = await this.collectFulfilledInBatches(
        projectDirs,
        this.fsProvider.type === "ssh" ? 8 : 24,
        async (dir) => {
          const projectPath = path.join(this.projectsDir, dir.name);
          const sessionEntries = await this.fsProvider.readdir(projectPath);
          const matchingIds = sessionEntries.filter(
            (e) => e.name.endsWith(".jsonl") && e.name.toLowerCase().includes(lowerFragment)
          ).map((e) => extractSessionId(e.name));
          return { projectId: dir.name, sessionIds: matchingIds };
        }
      );
      const allMatches = [];
      for (const { projectId, sessionIds } of perProjectMatches) {
        for (const sessionId of sessionIds) {
          allMatches.push({ projectId, sessionId });
          if (allMatches.length >= maxResults) break;
        }
        if (allMatches.length >= maxResults) break;
      }
      if (allMatches.length === 0) {
        return { found: false, results: [] };
      }
      const sessions = await this.collectFulfilledInBatches(
        allMatches,
        this.fsProvider.type === "ssh" ? 4 : 16,
        async (match) => {
          const session = await this.getSessionWithOptions(match.projectId, match.sessionId, {
            metadataLevel: "light"
          });
          return session ? { projectId: match.projectId, session } : null;
        }
      );
      const results = sessions.filter((s) => s !== null).sort((a, b) => b.session.createdAt - a.session.createdAt);
      return { found: results.length > 0, results };
    } catch (error) {
      logger$1.error(`Error finding sessions by partial ID ${fragment}:`, error);
      return { found: false, results: [] };
    }
  }
  /**
   * Resolve best-available file timestamps from directory entry metadata or stat fallback.
   */
  async resolveFileDetails(entry, filePath) {
    if (entry && typeof entry.mtimeMs === "number" && typeof entry.birthtimeMs === "number" && typeof entry.size === "number") {
      return {
        mtimeMs: entry.mtimeMs,
        birthtimeMs: entry.birthtimeMs,
        size: entry.size
      };
    }
    const stats = await this.fsProvider.stat(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs,
      size: stats.size
    };
  }
  parseTimestampMs(timestamp) {
    if (!timestamp) {
      return null;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }
  /**
   * Runs async mapping in bounded batches and returns only fulfilled results.
   * This prevents overwhelming SFTP servers with unbounded parallel requests.
   */
  async collectFulfilledInBatches(items, batchSize, mapper) {
    const safeBatchSize = Math.max(1, batchSize);
    const results = [];
    for (let i = 0; i < items.length; i += safeBatchSize) {
      const batch = items.slice(i, i + safeBatchSize);
      const settled = await Promise.allSettled(batch.map((item) => mapper(item)));
      for (const result of settled) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    }
    return results;
  }
  getErrorCode(error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = error.code;
      if (typeof code === "number") {
        return String(code);
      }
      if (typeof code === "string") {
        return code;
      }
    }
    return "";
  }
  isTransientFsError(error) {
    const code = this.getErrorCode(error);
    return code === "4" || code === "EAGAIN" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE";
  }
  async sleep(ms) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  /**
   * Resolves the project path for a given project ID.
   * For composite IDs, uses the registry's cwd directly.
   * For plain IDs, delegates to ProjectPathResolver.
   */
  async resolveProjectPathForId(projectId, sessionPaths) {
    const registryCwd = subprojectRegistry.getCwd(projectId);
    if (registryCwd) {
      return registryCwd;
    }
    const baseDir = extractBaseDir(projectId);
    return this.projectPathResolver.resolveProjectPath(baseDir, {
      sessionPaths
    });
  }
  /**
   * Checks whether a session file has non-noise displayable content.
   * Uses mtime+size memoization to avoid expensive re-parsing on repeated requests.
   */
  async hasDisplayableContent(filePath, mtimeMs, size) {
    try {
      const hasPrefetched = typeof mtimeMs === "number" && typeof size === "number";
      const stats = hasPrefetched ? null : await this.fsProvider.stat(filePath);
      const effectiveMtime = mtimeMs ?? stats?.mtimeMs ?? Date.now();
      const effectiveSize = size ?? stats?.size ?? -1;
      const cached = this.contentPresenceCache.get(filePath);
      if (cached?.mtimeMs === effectiveMtime && cached.size === effectiveSize) {
        return cached.hasContent;
      }
      const hasContent = await this.sessionContentFilter.hasNonNoiseMessages(
        filePath,
        this.fsProvider
      );
      this.contentPresenceCache.set(filePath, {
        mtimeMs: effectiveMtime,
        size: effectiveSize,
        hasContent
      });
      return hasContent;
    } catch {
      return false;
    }
  }
}
const logger = createLogger("Discovery:SubagentResolver");
const PARALLEL_WINDOW_MS = 100;
class SubagentResolver {
  constructor(projectScanner) {
    this.projectScanner = projectScanner;
  }
  // ===========================================================================
  // Main Resolution
  // ===========================================================================
  /**
   * Resolve all subagents for a session.
   */
  async resolveSubagents(projectId, sessionId, taskCalls, messages) {
    const subagentFiles = await this.projectScanner.listSubagentFiles(projectId, sessionId);
    if (subagentFiles.length === 0) {
      return [];
    }
    const parseConcurrency = this.projectScanner.getFileSystemProvider().type === "ssh" ? 4 : 24;
    const subagents = await this.collectInBatches(
      subagentFiles,
      parseConcurrency,
      async (filePath) => this.parseSubagentFile(filePath)
    );
    const validSubagents = subagents.filter((s) => s !== null);
    this.linkToTaskCalls(validSubagents, taskCalls, messages ?? []);
    this.propagateTeamMetadata(validSubagents);
    this.detectParallelExecution(validSubagents);
    if (messages) {
      this.enrichTeamColors(validSubagents, messages);
    }
    validSubagents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return validSubagents;
  }
  // ===========================================================================
  // Subagent Parsing
  // ===========================================================================
  /**
   * Parse a single subagent file.
   */
  async parseSubagentFile(filePath) {
    try {
      const messages = await parseJsonlFile(filePath, this.projectScanner.getFileSystemProvider());
      if (messages.length === 0) {
        return null;
      }
      if (this.isWarmupSubagent(messages)) {
        return null;
      }
      const filename = path.basename(filePath);
      const agentId = filename.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      if (agentId.startsWith("acompact")) {
        return null;
      }
      const { startTime, endTime, durationMs } = this.calculateTiming(messages);
      const metrics = calculateMetrics(messages);
      const isOngoing = checkMessagesOngoing(messages);
      return {
        id: agentId,
        filePath,
        messages,
        startTime,
        endTime,
        durationMs,
        metrics,
        isParallel: false,
        // Will be set by detectParallelExecution
        isOngoing
      };
    } catch (error) {
      logger.error(`Error parsing subagent file ${filePath}:`, error);
      return null;
    }
  }
  /**
   * Check if this is a warmup subagent that should be filtered out.
   * Warmup subagents are pre-warming agents spawned by Claude Code that have:
   * - First user message with content exactly "Warmup"
   * - isSidechain: true (all subagents have this)
   */
  isWarmupSubagent(messages) {
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (!firstUserMessage) {
      return false;
    }
    return firstUserMessage.content === "Warmup";
  }
  /**
   * Extract the summary attribute from the first <teammate-message> tag in a subagent's messages.
   * Returns the summary string if found, undefined otherwise.
   * Used to match team member files to their spawning Task calls.
   */
  extractTeamMessageSummary(messages) {
    const firstUserMessage = messages.find((m) => m.type === "user");
    if (!firstUserMessage) return void 0;
    const text = typeof firstUserMessage.content === "string" ? firstUserMessage.content : "";
    const match = /<teammate-message[^>]*\bsummary="([^"]+)"/.exec(text);
    return match?.[1];
  }
  /**
   * Calculate timing from messages.
   */
  calculateTiming(messages) {
    const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));
    if (timestamps.length === 0) {
      const now = /* @__PURE__ */ new Date();
      return { startTime: now, endTime: now, durationMs: 0 };
    }
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    return {
      startTime: new Date(minTime),
      endTime: new Date(maxTime),
      durationMs: maxTime - minTime
    };
  }
  // ===========================================================================
  // Task Call Linking
  // ===========================================================================
  /**
   * Link subagents to their parent Task tool calls.
   *
   * Uses result-based matching: reads tool_result messages from the parent session
   * to find agentId values, then matches subagent files by their ID. Falls back to
   * positional matching (without wrap-around) for any remaining unmatched subagents.
   *
   * After matching, enriches subagents with Task call metadata (description, subagentType).
   */
  linkToTaskCalls(subagents, taskCalls, messages) {
    const taskCallsOnly = taskCalls.filter((tc) => tc.isTask);
    if (taskCallsOnly.length === 0 || subagents.length === 0) {
      return;
    }
    const agentIdToTaskId = /* @__PURE__ */ new Map();
    for (const msg of messages) {
      if (!msg.toolUseResult) continue;
      const result = msg.toolUseResult;
      const agentId = result.agentId ?? result.agent_id;
      if (!agentId) continue;
      const taskCallId = msg.sourceToolUseID ?? msg.toolResults[0]?.toolUseId;
      if (taskCallId) {
        agentIdToTaskId.set(agentId, taskCallId);
      }
    }
    const taskCallById = new Map(taskCallsOnly.map((tc) => [tc.id, tc]));
    const matchedSubagentIds = /* @__PURE__ */ new Set();
    const matchedTaskIds = /* @__PURE__ */ new Set();
    for (const subagent of subagents) {
      const taskCallId = agentIdToTaskId.get(subagent.id);
      if (!taskCallId) continue;
      const taskCall = taskCallById.get(taskCallId);
      if (!taskCall) continue;
      this.enrichSubagentFromTask(subagent, taskCall);
      matchedSubagentIds.add(subagent.id);
      matchedTaskIds.add(taskCallId);
    }
    const teamTaskCalls = taskCallsOnly.filter(
      (tc) => !matchedTaskIds.has(tc.id) && tc.input?.team_name && tc.input?.name
    );
    if (teamTaskCalls.length > 0) {
      const subagentSummaries = /* @__PURE__ */ new Map();
      for (const subagent of subagents) {
        if (matchedSubagentIds.has(subagent.id)) continue;
        const summary = this.extractTeamMessageSummary(subagent.messages);
        if (summary) {
          subagentSummaries.set(subagent.id, summary);
        }
      }
      for (const taskCall of teamTaskCalls) {
        const description = taskCall.taskDescription;
        if (!description) continue;
        let bestMatch;
        for (const subagent of subagents) {
          if (matchedSubagentIds.has(subagent.id)) continue;
          if (subagentSummaries.get(subagent.id) !== description) continue;
          if (!bestMatch || subagent.startTime < bestMatch.startTime) {
            bestMatch = subagent;
          }
        }
        if (bestMatch) {
          this.enrichSubagentFromTask(bestMatch, taskCall);
          matchedSubagentIds.add(bestMatch.id);
          matchedTaskIds.add(taskCall.id);
        }
      }
    }
    const unmatchedSubagents = [...subagents].filter((s) => !matchedSubagentIds.has(s.id)).sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const unmatchedTasks = taskCallsOnly.filter(
      (tc) => !matchedTaskIds.has(tc.id) && !(tc.input?.team_name && tc.input?.name)
    );
    for (let i = 0; i < unmatchedSubagents.length && i < unmatchedTasks.length; i++) {
      this.enrichSubagentFromTask(unmatchedSubagents[i], unmatchedTasks[i]);
    }
  }
  /**
   * Enrich a subagent with metadata from its parent Task call.
   * Intentionally mutates the subagent in place for consistency with other resolution methods.
   */
  enrichSubagentFromTask(subagent, taskCall) {
    subagent.parentTaskId = taskCall.id;
    subagent.description = taskCall.taskDescription;
    subagent.subagentType = taskCall.taskSubagentType;
    const teamName = taskCall.input?.team_name;
    const memberName = taskCall.input?.name;
    if (teamName && memberName) {
      subagent.team = { teamName, memberName, memberColor: "" };
    }
  }
  /**
   * Enrich team member subagents with color information from tool results.
   * Teammate spawned results contain color information.
   */
  enrichTeamColors(subagents, messages) {
    for (const msg of messages) {
      if (!msg.toolUseResult) continue;
      const sourceId = msg.sourceToolUseID ?? msg.toolResults[0]?.toolUseId;
      if (!sourceId) continue;
      const result = msg.toolUseResult;
      if (result.status === "teammate_spawned" && result.color) {
        for (const subagent of subagents) {
          if (subagent.parentTaskId === sourceId && subagent.team) {
            subagent.team.memberColor = result.color;
          }
        }
      }
    }
  }
  /**
   * Propagate team metadata to continuation files via parentUuid chain.
   *
   * Team members generate multiple JSONL files (one per activation/turn).
   * Only the primary file is matched by linkToTaskCalls (Phase 2 description match).
   * Continuation files (task assignments, shutdown responses) are linked to the
   * same teammate by following the parentUuid chain: a continuation file's first
   * message.parentUuid matches the last message.uuid of the previous file.
   */
  propagateTeamMetadata(subagents) {
    const lastUuidToSubagent = /* @__PURE__ */ new Map();
    for (const subagent of subagents) {
      if (subagent.messages.length === 0) continue;
      const lastMsg = subagent.messages[subagent.messages.length - 1];
      if (lastMsg.uuid) {
        lastUuidToSubagent.set(lastMsg.uuid, subagent);
      }
    }
    const maxDepth = 10;
    for (const subagent of subagents) {
      if (subagent.team) continue;
      if (subagent.messages.length === 0) continue;
      const firstMsg = subagent.messages[0];
      if (!firstMsg.parentUuid) continue;
      let ancestor = lastUuidToSubagent.get(firstMsg.parentUuid);
      let depth = 0;
      while (ancestor && !ancestor.team && depth < maxDepth) {
        if (ancestor.messages.length === 0) break;
        const parentUuid = ancestor.messages[0].parentUuid;
        if (!parentUuid) break;
        ancestor = lastUuidToSubagent.get(parentUuid);
        depth++;
      }
      if (ancestor?.team) {
        subagent.team = { ...ancestor.team };
        subagent.parentTaskId = subagent.parentTaskId ?? ancestor.parentTaskId;
        subagent.description = subagent.description ?? ancestor.description;
        subagent.subagentType = subagent.subagentType ?? ancestor.subagentType;
      }
    }
  }
  // ===========================================================================
  // Parallel Detection
  // ===========================================================================
  /**
   * Detect parallel execution among subagents.
   * Subagents with start times within PARALLEL_WINDOW_MS are marked as parallel.
   */
  detectParallelExecution(subagents) {
    if (subagents.length < 2) return;
    const sorted = [...subagents].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const groups = [];
    let currentGroup = [];
    let groupStartTime = 0;
    for (const agent of sorted) {
      const startMs = agent.startTime.getTime();
      if (currentGroup.length === 0) {
        currentGroup.push(agent);
        groupStartTime = startMs;
      } else if (startMs - groupStartTime <= PARALLEL_WINDOW_MS) {
        currentGroup.push(agent);
      } else {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [agent];
        groupStartTime = startMs;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    for (const group of groups) {
      if (group.length > 1) {
        for (const agent of group) {
          agent.isParallel = true;
        }
      }
    }
  }
  // ===========================================================================
  // Utility Methods
  // ===========================================================================
  /**
   * Get subagent by ID.
   */
  findSubagentById(subagents, id) {
    return subagents.find((s) => s.id === id);
  }
  /**
   * Get parallel subagent groups.
   */
  getParallelGroups(subagents) {
    const parallelAgents = subagents.filter((s) => s.isParallel);
    if (parallelAgents.length === 0) return [];
    const sorted = [...parallelAgents].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime()
    );
    const groups = [];
    let currentGroup = [];
    let groupStartTime = 0;
    for (const agent of sorted) {
      const startMs = agent.startTime.getTime();
      if (currentGroup.length === 0) {
        currentGroup.push(agent);
        groupStartTime = startMs;
      } else if (startMs - groupStartTime <= PARALLEL_WINDOW_MS) {
        currentGroup.push(agent);
      } else {
        groups.push(currentGroup);
        currentGroup = [agent];
        groupStartTime = startMs;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    return groups.filter((g) => g.length > 1);
  }
  /**
   * Calculate total metrics for all subagents.
   */
  getTotalSubagentMetrics(subagents) {
    if (subagents.length === 0) {
      return {
        durationMs: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: 0
      };
    }
    let totalDuration = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let messageCount = 0;
    for (const agent of subagents) {
      totalDuration += agent.durationMs;
      inputTokens += agent.metrics.inputTokens;
      outputTokens += agent.metrics.outputTokens;
      cacheReadTokens += agent.metrics.cacheReadTokens;
      cacheCreationTokens += agent.metrics.cacheCreationTokens;
      messageCount += agent.metrics.messageCount;
    }
    return {
      durationMs: totalDuration,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      messageCount
    };
  }
  async collectInBatches(items, batchSize, mapper) {
    const safeBatchSize = Math.max(1, batchSize);
    const results = [];
    for (let i = 0; i < items.length; i += safeBatchSize) {
      const batch = items.slice(i, i + safeBatchSize);
      const settled = await Promise.allSettled(batch.map((item) => mapper(item)));
      for (const result of settled) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        }
      }
    }
    return results;
  }
}
const LOOP_MIN_STREAK = 4;
const WAIT_TICK_CONTEXT_TOKENS = 5e4;
const WAIT_TICK_OUTPUT_TOKENS = 300;
const WAIT_LOOP_MIN_TICKS = 5;
function isQuietTick(billedContextTokens, outputTokens, toolCallCount) {
  return toolCallCount === 0 && billedContextTokens >= WAIT_TICK_CONTEXT_TOKENS && outputTokens <= WAIT_TICK_OUTPUT_TOKENS;
}
const STALL_CONTEXT_DELTA_TOKENS = 300;
function isStalledRound(prevContextTokens, contextTokens, outputTokens, toolCallCount) {
  const delta = contextTokens - prevContextTokens;
  return toolCallCount > 0 && prevContextTokens > 0 && // first round / ghost baseline — nothing to compare
  delta >= 0 && // a shrinking window (compaction) is not a stall
  delta <= STALL_CONTEXT_DELTA_TOKENS && outputTokens <= WAIT_TICK_OUTPUT_TOKENS;
}
function asText(v) {
  if (typeof v === "string") return v;
  if (v === void 0 || v === null) return "";
  return JSON.stringify(v);
}
const squash = (v) => asText(v).replace(/\s+/g, " ").trim();
const fnv1a = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};
function normalizeCallKey(name, input) {
  switch (name) {
    case "Bash":
      return `Bash|${squash(input.command)}`;
    case "Read": {
      const sliced = input.offset !== void 0 || input.limit !== void 0 || input.pages !== void 0;
      const window = sliced ? `|${asText(input.offset)}|${asText(input.limit)}|${asText(input.pages)}` : "";
      return `Read|${asText(input.file_path)}${window}`;
    }
    case "Write":
      return `Write|${asText(input.file_path)}|${fnv1a(asText(input.content))}`;
    case "Edit": {
      const delta = `${asText(input.old_string)}→${asText(input.new_string)}`;
      return `Edit|${asText(input.file_path)}|${fnv1a(delta)}`;
    }
    case "NotebookEdit": {
      return `NotebookEdit|${asText(input.notebook_path ?? input.file_path)}|${fnv1a(asText(input.new_source))}`;
    }
    case "Grep":
    case "Glob":
      return `${name}|${asText(input.pattern)}|${asText(input.path)}`;
    case "Skill":
      return `Skill|${asText(input.skill)}`;
    case "Task":
    case "Agent":
      return `Task|${asText(input.description) || asText(input.prompt)}`;
    default:
      return `${name}|${JSON.stringify(
        Object.fromEntries(
          Object.keys(input).sort((a, b) => a.localeCompare(b)).map((k) => [k, input[k]])
        )
      )}`;
  }
}
function bashStem(key) {
  if (!key.startsWith("Bash|")) return key;
  const pipe = key.indexOf("|", 5);
  return pipe === -1 ? key : key.slice(0, pipe).trimEnd();
}
function formatTokensCompact(tokens) {
  if (tokens >= 1e6) {
    return `${(tokens / 1e6).toFixed(1)}M`;
  }
  if (tokens >= 1e3) {
    return `${(tokens / 1e3).toFixed(1)}k`;
  }
  return tokens.toString();
}
function formatTokensDetailed(tokens) {
  return tokens.toLocaleString();
}
function estimateTokens(text) {
  if (!text || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}
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
function detectBillingScheme(rounds) {
  let sawWrite = false;
  let sawRead = false;
  for (const r of rounds) {
    if (r.cacheCreationTokens > 0) sawWrite = true;
    else if (r.cacheReadTokens > 0) sawRead = true;
  }
  return billingFromFlags(sawWrite, sawRead);
}
function billingFromFlags(sawWrite, sawRead) {
  if (sawWrite && sawRead) return "mixed";
  if (sawWrite) return "anthropic-style";
  if (sawRead) return "router-style";
  return "no-cache";
}
const WASTE_THRESHOLDS = {
  oversizedOutputTokens: 8e3,
  contextSpikeTokens: 3e4,
  cacheDeadContextTokens: 2e4,
  thinkingHeavyTokens: 8e3,
  longTurnActiveMinutes: 45,
  loopStreakMin: LOOP_MIN_STREAK,
  // from @shared/constants/loopPolicy — shared with the panel and the bell's default cycleThreshold (#96)
  waitLoopTicks: WAIT_LOOP_MIN_TICKS
  // from @shared/constants/loopPolicy — shared with the renderer
};
const TURN_IDLE_GAP_CAP_MINUTES = 10;
const REJECTION_PATTERNS = [
  "The user doesn't want to proceed with this tool use",
  "[Request interrupted by user"
];
const WASTE_TYPE_PRIORITY = [
  // result:<toolUseId> — the call's own output tokens
  "failed_call",
  // an error result is waste with certainty
  "loop_streak",
  // back-to-back identical repeats
  "duplicate_call",
  // repeats after intervening work
  "probe_no_progress",
  // same-result re-asks
  "oversized_output",
  // weakest claim — the data may be legitimately needed
  // round:<index> — the round's whole context
  "cache_dead",
  // the round billed entirely as fresh input
  "stall_streak",
  // calls with no context growth
  "wait_loop",
  // idle quiet ticks
  "cycle_motif"
  // repeating motif rounds
];
function allocateWaste(findings) {
  const remaining = /* @__PURE__ */ new Map();
  const ownerUsdRate = /* @__PURE__ */ new Map();
  const ownerEqRate = /* @__PURE__ */ new Map();
  const ownerPriced = /* @__PURE__ */ new Map();
  for (const f of findings) {
    let allocated = f.free ?? 0;
    let usd = f.free !== void 0 ? f.freeUsd : 0;
    let eq = f.free !== void 0 ? f.freeInputEq : 0;
    for (const claim of f.claims ?? []) {
      if (!remaining.has(claim.owner)) {
        remaining.set(claim.owner, claim.cap);
        ownerUsdRate.set(claim.owner, claim.usdRate ?? 0);
        ownerEqRate.set(claim.owner, claim.inputEqRate ?? 0);
        ownerPriced.set(claim.owner, claim.usdRate !== void 0);
      }
      const left = remaining.get(claim.owner) ?? 0;
      const take = Math.min(claim.want, left);
      remaining.set(claim.owner, left - take);
      allocated += take;
      usd = ownerPriced.get(claim.owner) && usd !== void 0 ? usd + take * (ownerUsdRate.get(claim.owner) ?? 0) : void 0;
      eq = ownerPriced.get(claim.owner) && eq !== void 0 ? eq + take * (ownerEqRate.get(claim.owner) ?? 0) : void 0;
    }
    f.tokensWasted = allocated;
    if (usd !== void 0 && usd > 0) f.wastedUsd = usd;
    if (eq !== void 0 && eq > 0) f.tokensWastedInputEq = eq;
  }
}
function billedThinkingTokens(msg) {
  const output = msg.usage?.output_tokens ?? 0;
  let visibleChars = 0;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text") visibleChars += block.text.length;
    }
  }
  for (const call of msg.toolCalls) visibleChars += JSON.stringify(call.input).length;
  return Math.max(0, output - Math.ceil(visibleChars / 4));
}
function turnActiveMinutes(rounds) {
  let ms = 0;
  for (let i = 1; i < rounds.length; i++) {
    const gap = rounds[i].timestamp.getTime() - rounds[i - 1].timestamp.getTime();
    ms += Math.min(Math.max(gap, 0), TURN_IDLE_GAP_CAP_MINUTES * 6e4);
  }
  return ms / 6e4;
}
function roundsByTurn(rounds) {
  const byTurn = /* @__PURE__ */ new Map();
  for (const r of rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }
  return byTurn;
}
const countTools = (rs) => {
  const counts = /* @__PURE__ */ new Map();
  for (const r of rs) {
    for (const name of r.tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
};
function totalsFromRounds(rounds) {
  const t = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    billedTokens: 0,
    rereadShare: 0,
    thinkingTokens: 0
  };
  let costUsd = 0;
  let unpriced = false;
  for (const r of rounds) {
    t.inputTokens += r.inputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheCreationTokens += r.cacheCreationTokens;
    t.outputTokens += r.outputTokens;
    t.thinkingTokens += r.thinkingTokens;
    const c = roundCostUsd(r);
    if (c === null) unpriced = true;
    else costUsd += c;
  }
  t.billedTokens = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens + t.outputTokens;
  t.rereadShare = t.billedTokens > 0 ? t.cacheReadTokens / t.billedTokens : 0;
  const noUsageRounds = rounds.filter((r) => r.contextSize === 0).length;
  const retryCopies = rounds.filter((r) => r.isRetryCopy === true).length;
  let longestTurn;
  for (const [turn, rs] of roundsByTurn(rounds)) {
    const active = turnActiveMinutes(rs);
    if (!longestTurn || active > longestTurn.activeMinutes) {
      longestTurn = { turn, activeMinutes: active, rounds: rs.length };
    }
  }
  return {
    ...t,
    noUsageRounds,
    retryCopies,
    ...longestTurn ? { longestTurn } : {},
    ...costUsd > 0 ? { costUsd, costPartial: unpriced } : {}
  };
}
function breakdownFromRounds(rounds, withCost = true) {
  const byModel = /* @__PURE__ */ new Map();
  for (const r of rounds) {
    let row = byModel.get(r.model);
    if (!row) {
      row = {
        model: r.model,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        billedTokens: 0
      };
      byModel.set(r.model, row);
    }
    row.inputTokens += r.inputTokens;
    row.cacheReadTokens += r.cacheReadTokens;
    row.cacheCreationTokens += r.cacheCreationTokens;
    row.outputTokens += r.outputTokens;
    row.billedTokens += r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens;
    if (withCost) {
      const c = roundCostUsd(r);
      if (c === null) delete row.costUsd;
      else row.costUsd = (row.costUsd ?? 0) + c;
    }
  }
  return [...byModel.values()].sort((a, b) => b.billedTokens - a.billedTokens);
}
function filterLedgerByDate(ledger, since, until) {
  if (!since && !until) return ledger;
  const rounds = ledger.rounds.filter((r) => inDateRange(r.timestamp, since, until));
  const keptTurns = new Set(rounds.map((r) => r.turnIndex));
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const r of rounds) {
    minTs = Math.min(minTs, r.timestamp.getTime());
    maxTs = Math.max(maxTs, r.timestamp.getTime());
  }
  const byTurn = roundsByTurn(rounds);
  const turns = ledger.turns.filter((t) => keptTurns.has(t.index)).map((t) => ({ ...t, activeMinutes: turnActiveMinutes(byTurn.get(t.index) ?? []) }));
  return {
    turns,
    rounds,
    totals: totalsFromRounds(rounds),
    models: [...new Set(rounds.map((r) => r.model))],
    durationMs: Number.isFinite(minTs) ? Math.max(0, maxTs - minTs) : 0,
    activeMinutes: turns.reduce((s, t) => s + t.activeMinutes, 0),
    billing: detectBillingScheme(rounds)
  };
}
function getRetryCopyMessageIds(allMessages) {
  const copies = /* @__PURE__ */ new Set();
  let anchor = null;
  for (const msg of deduplicateByRequestId(allMessages)) {
    if (isParsedUserChunkMessage(msg)) continue;
    if (msg.type !== "assistant" || msg.isSidechain) continue;
    if (!msg.usage || msg.model === "<synthetic>") continue;
    const u = msg.usage;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const isCopy = anchor !== null && !msg.requestId && anchor.model === (msg.model ?? "unknown") && anchor.input === input && anchor.cr === cacheRead && anchor.cw === cacheWrite && anchor.out === output && msg.timestamp.getTime() - anchor.ts <= 12e4;
    if (isCopy) copies.add(msg.uuid);
    if (input + cacheRead + cacheWrite > 0 && !isCopy) {
      anchor = {
        model: msg.model ?? "unknown",
        input,
        cr: cacheRead,
        cw: cacheWrite,
        out: output,
        ts: msg.timestamp.getTime()
      };
    }
  }
  return copies;
}
function buildLedger(allMessages) {
  const messages = deduplicateByRequestId(allMessages);
  const retryCopies = getRetryCopyMessageIds(messages);
  const turns = [];
  const rounds = [];
  const models = /* @__PURE__ */ new Set();
  let currentTurn = null;
  let prevContext = 0;
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  let gapToolTok = 0;
  let gapTextTok = 0;
  const newTurn = (ts) => {
    const turn = { index: turns.length + 1, start: ts, activeMinutes: 0 };
    turns.push(turn);
    currentTurn = turn;
    return turn;
  };
  for (const msg of messages) {
    minTs = Math.min(minTs, msg.timestamp.getTime());
    maxTs = Math.max(maxTs, msg.timestamp.getTime());
    if (msg.isCompactSummary) continue;
    if ((isParsedUserChunkMessage(msg) || isParsedTeammateRelayMessage(msg)) && !msg.isSidechain) {
      gapTextTok += estimateTokens(injectedText(msg.content));
      newTurn(msg.timestamp);
      continue;
    }
    if (msg.isSidechain) continue;
    if (msg.type !== "assistant") {
      for (const r of msg.toolResults) gapToolTok += estimateTokens(resultText(r.content));
      gapTextTok += estimateTokens(injectedText(msg.content));
      continue;
    }
    if (!msg.usage || msg.model === "<synthetic>") continue;
    const turn = currentTurn ?? newTurn(msg.timestamp);
    const u = msg.usage;
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const ttlSplit = cacheWrite > 0 ? u.cache_creation : void 0;
    const contextSize = input + cacheRead + cacheWrite;
    const think = billedThinkingTokens(msg);
    const model = msg.model ?? "unknown";
    const tools = msg.toolCalls.map((tc) => tc.name);
    const isRetryCopy = retryCopies.has(msg.uuid);
    const round = {
      index: rounds.length + 1,
      timestamp: msg.timestamp,
      turnIndex: turn.index,
      model,
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      cacheWrite5mTokens: ttlSplit ? ttlSplit.ephemeral_5m_input_tokens ?? 0 : void 0,
      cacheWrite1hTokens: ttlSplit ? ttlSplit.ephemeral_1h_input_tokens ?? 0 : void 0,
      outputTokens: output,
      contextSize,
      // empty rounds (provider ghosts, #14) must not drag the baseline to 0
      contextDelta: rounds.length === 0 || contextSize === 0 ? 0 : contextSize - prevContext,
      thinkingTokens: think,
      tools,
      // ghosts (#14) book no gap: contextSize 0 swallows nothing, the gap
      // belongs to the next request that actually grows the context
      resultTokens: contextSize > 0 ? gapToolTok : 0,
      injectedTextTokens: contextSize > 0 ? gapTextTok : 0,
      isRetryCopy: isRetryCopy || void 0
    };
    if (contextSize > 0) {
      gapToolTok = 0;
      gapTextTok = 0;
      prevContext = contextSize;
    }
    rounds.push(round);
    models.add(model);
  }
  const byTurn = roundsByTurn(rounds);
  for (const turn of turns) {
    turn.activeMinutes = turnActiveMinutes(byTurn.get(turn.index) ?? []);
  }
  return {
    turns,
    rounds,
    totals: totalsFromRounds(rounds),
    models: [...models],
    durationMs: Number.isFinite(minTs) ? Math.max(0, maxTs - minTs) : 0,
    activeMinutes: turns.reduce((s, t) => s + t.activeMinutes, 0),
    billing: detectBillingScheme(rounds)
  };
}
function resultText(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}
function injectedText(content) {
  if (typeof content === "string") return content;
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += `${block.text}
`;
  }
  return text;
}
function contextSpikeSummary(prev, r) {
  const span = `(${formatTokensCompact(r.contextSize - r.contextDelta)} → ${formatTokensCompact(r.contextSize)})`;
  const roundTag = prev ? `round ${prev.index}` : "the previous round";
  const sources = [];
  if (r.resultTokens > 0) {
    sources.push(
      `~${formatTokensCompact(r.resultTokens)} tok of ${roundTag} results (${prev?.tools.join(", ") || "tool calls"})`
    );
  }
  if (r.injectedTextTokens > 0) {
    sources.push(
      `~${formatTokensCompact(r.injectedTextTokens)} tok injected as user/meta text (skill body, attachment, user message — not a tool result)`
    );
  }
  const cause = sources.length > 0 ? sources.join(" + ") : `${roundTag}'s own output (no tool result or injection recorded)`;
  return `context +${formatTokensCompact(r.contextDelta)} after ${cause} ${span}`;
}
function residencyPricer(ledger) {
  const rounds = ledger.rounds;
  const readAfter = [];
  if (rounds.length > 0) readAfter[rounds.length - 1] = 0;
  for (let k = rounds.length - 2; k >= 0; k--) {
    const next = rounds[k + 1];
    if (next.contextDelta < 0) {
      readAfter[k] = 0;
      continue;
    }
    const tail = readAfter[k + 1];
    const p = next.contextSize > 0 ? priceForRound(next) : null;
    readAfter[k] = p && tail !== null ? p.cacheRead + tail : next.contextSize === 0 ? tail : null;
  }
  let cursor = 0;
  const appearingRoundOf = (ts) => {
    while (cursor + 1 < rounds.length && rounds[cursor + 1].timestamp.getTime() <= ts) {
      cursor += 1;
    }
    return rounds.length > 0 && rounds[cursor].timestamp.getTime() <= ts ? cursor : -1;
  };
  const rates = (perMTok, inputPerMTok) => ({
    usdRate: perMTok / 1e6,
    inputEqRate: perMTok / inputPerMTok
  });
  return {
    resultRates(ts) {
      const k = appearingRoundOf(ts);
      if (k < 0) return void 0;
      const next = rounds[k + 1];
      if (!next) return { usdRate: 0, inputEqRate: 0 };
      const p = priceForRound(next);
      const after = readAfter[k + 1];
      if (!p || after === null) return void 0;
      return rates(p.cacheWrite5m + after, p.input);
    },
    roundRates(r) {
      const p = priceForRound(r);
      if (!p || r.contextSize === 0) return void 0;
      const cw5 = r.cacheWrite5mTokens ?? r.cacheCreationTokens;
      const cw1 = r.cacheWrite1hTokens ?? 0;
      const perMTok = r.inputTokens * p.input + r.cacheReadTokens * p.cacheRead + cw5 * p.cacheWrite5m + cw1 * p.cacheWrite1h;
      return rates(perMTok / r.contextSize, p.input);
    },
    roundRatesByIndex(index) {
      const r = rounds[index - 1];
      return r ? this.roundRates(r) : void 0;
    },
    premiumRates(r) {
      const p = priceForRound(r);
      if (!p) return void 0;
      return rates(p.input - p.cacheRead, p.input);
    },
    inputRates(ts) {
      const k = appearingRoundOf(ts);
      if (k < 0) return void 0;
      const p = priceForRound(rounds[k]);
      if (!p) return void 0;
      return rates(p.input, p.input);
    }
  };
}
function computeFindings(messages, ledger, since, until) {
  const findings = [];
  const th = WASTE_THRESHOLDS;
  const pricer = residencyPricer(ledger);
  const results = /* @__PURE__ */ new Map();
  for (const msg of messages) {
    if (msg.isSidechain) continue;
    for (const r of msg.toolResults) {
      results.set(r.toolUseId, { content: r.content, isError: r.isError });
    }
  }
  const retryCopies = getRetryCopyMessageIds(messages);
  const seen = /* @__PURE__ */ new Map();
  let turnCursor = 0;
  const turnOf = (ts) => {
    const turns = ledger.turns;
    if (turns.length === 0 || ts < turns[0].start.getTime()) return void 0;
    while (turnCursor + 1 < turns.length && turns[turnCursor + 1].start.getTime() <= ts) {
      turnCursor += 1;
    }
    return turns[turnCursor].index;
  };
  let streakKey = null;
  let streak = null;
  const flushStreak = () => {
    if (streak && streakKey && streak.count >= th.loopStreakMin) {
      const env = streak.errors === streak.count;
      findings.push({
        type: "loop_streak",
        kind: "waste",
        severity: streak.count >= 5 ? "high" : "medium",
        tokensWasted: streak.tokens,
        turnIndex: streak.turn,
        basis: "estimated",
        summary: `${short(streakKey, 60)} — x${streak.count} back-to-back (${env ? "env loop — same failure each time" : "no-op loop"}) ${hhmm(streak.start)}–${hhmm(streak.end)}`,
        claims: streak.members.map((m) => ({
          owner: `result:${m.id}`,
          want: m.tok,
          cap: m.tok,
          ...m.rates ?? {}
        }))
      });
    }
    streak = null;
    streakKey = null;
  };
  for (const msg of messages) {
    if (msg.isSidechain) continue;
    if (retryCopies.has(msg.uuid)) continue;
    if (!inDateRange(msg.timestamp, since, until)) continue;
    for (const call of msg.toolCalls) {
      const key = bashStem(normalizeCallKey(call.name, call.input));
      const result = results.get(call.id);
      const text = result ? resultText(result.content) : "";
      const resultTok = estimateTokens(text);
      if (streak && streakKey === key) {
        streak.count += 1;
        streak.tokens += resultTok;
        streak.members.push({
          id: call.id,
          tok: resultTok,
          rates: pricer.resultRates(msg.timestamp.getTime())
        });
        if (result?.isError) streak.errors += 1;
        streak.end = msg.timestamp;
      } else {
        flushStreak();
        streakKey = key;
        streak = {
          count: 1,
          tokens: 0,
          errors: result?.isError ? 1 : 0,
          turn: turnOf(msg.timestamp.getTime()),
          start: msg.timestamp,
          end: msg.timestamp,
          members: []
        };
      }
      if (result?.isError) {
        const rejected = REJECTION_PATTERNS.some((p) => text.includes(p));
        if (!rejected) {
          const inputTok = estimateTokens(JSON.stringify(call.input));
          const ir = pricer.inputRates(msg.timestamp.getTime());
          const rr = pricer.resultRates(msg.timestamp.getTime());
          findings.push({
            type: "failed_call",
            kind: "waste",
            severity: "medium",
            tokensWasted: inputTok + resultTok,
            basis: "estimated",
            summary: `${call.name} failed: ${short(text, 80)}`,
            // the call's own args are uncontested; the result competes with
            // oversized/duplicate/streak/probe claims on the same toolUseId —
            // the claim stays unconditional (unpriced drops only the rates),
            // otherwise the overlapped findings' raw booking would shift
            free: inputTok,
            ...ir ? { freeUsd: inputTok * (ir.usdRate ?? 0), freeInputEq: inputTok } : {},
            claims: [
              {
                owner: `result:${call.id}`,
                want: resultTok,
                cap: resultTok,
                ...rr ?? {}
              }
            ]
          });
        }
      }
      if (resultTok > th.oversizedOutputTokens) {
        findings.push({
          type: "oversized_output",
          kind: "waste",
          severity: "medium",
          tokensWasted: resultTok,
          basis: "estimated",
          summary: `${call.name} returned ~${formatTokensCompact(resultTok)} tok: ${short(call.name === "Bash" ? asText(call.input.command) : JSON.stringify(call.input), 70)}`,
          claims: [
            {
              owner: `result:${call.id}`,
              want: resultTok,
              cap: resultTok,
              ...pricer.resultRates(msg.timestamp.getTime()) ?? {}
            }
          ]
        });
      }
      const prev = seen.get(key);
      if (prev) {
        prev.count += 1;
        prev.tokens += resultTok;
        prev.repeats.push({
          id: call.id,
          tok: resultTok,
          rates: pricer.resultRates(msg.timestamp.getTime())
        });
      } else {
        seen.set(key, { count: 1, tokens: resultTok, first: resultTok, repeats: [] });
      }
    }
  }
  flushStreak();
  for (const [key, { count, tokens, first, repeats }] of seen) {
    if (count > 1) {
      const reread = tokens - first;
      findings.push({
        type: "duplicate_call",
        kind: "waste",
        severity: "medium",
        tokensWasted: reread,
        basis: "estimated",
        summary: `${short(key, 90)} — called ${count}x (~${formatTokensCompact(reread)} tok of results re-read)`,
        claims: repeats.map((rp) => ({
          owner: `result:${rp.id}`,
          want: rp.tok,
          cap: rp.tok,
          ...rp.rates ?? {}
        }))
      });
    }
  }
  for (let i = 0; i < ledger.rounds.length; i++) {
    const r = ledger.rounds[i];
    if (r.isRetryCopy) continue;
    if (r.contextDelta > th.contextSpikeTokens) {
      let j = i - 1;
      while (j >= 0 && ledger.rounds[j].contextSize === 0) j--;
      const prev = ledger.rounds[j];
      findings.push({
        type: "context_spike",
        // #84: an observation — a big growth is often legitimate (a needed
        // large file); recording the delta as loss would inflate the waste
        kind: "observation",
        severity: "high",
        // the summary carries the delta, sources and span; nothing is booked
        tokensWasted: 0,
        turnIndex: r.turnIndex,
        basis: "measured",
        summary: contextSpikeSummary(prev, r)
      });
    }
    if (r.contextSize > th.cacheDeadContextTokens && r.cacheReadTokens === 0 && r.cacheCreationTokens === 0) {
      findings.push({
        type: "cache_dead",
        kind: "waste",
        severity: "high",
        tokensWasted: r.contextSize,
        turnIndex: r.turnIndex,
        basis: "measured",
        summary: `no prompt caching: ${formatTokensCompact(r.contextSize)} tok billed as fresh input (model ${r.model})`,
        // #82: the dollars book only the fresh-input premium over a cache read
        claims: [
          {
            owner: `round:${r.index}`,
            want: r.contextSize,
            cap: r.contextSize,
            ...pricer.premiumRates(r) ?? {}
          }
        ]
      });
    }
  }
  const byTurn = roundsByTurn(ledger.rounds);
  for (const turn of ledger.turns) {
    const rs = byTurn.get(turn.index) ?? [];
    const think = rs.reduce((s, r) => s + r.thinkingTokens, 0);
    if (think > th.thinkingHeavyTokens) {
      let usd = 0;
      let eq = 0;
      for (const r of rs) {
        const p = priceForRound(r);
        if (!p) {
          usd = void 0;
          eq = void 0;
          break;
        }
        usd += r.thinkingTokens * p.output / 1e6;
        eq += r.thinkingTokens * (p.output / p.input);
      }
      findings.push({
        type: "thinking_heavy",
        kind: "waste",
        severity: "low",
        tokensWasted: think,
        turnIndex: turn.index,
        basis: "estimated",
        summary: `thinking ~${formatTokensCompact(think)} tok in turn ${turn.index}`,
        free: think,
        // estimate — no competing claimant books thinking
        ...usd !== void 0 && eq !== void 0 ? { freeUsd: usd, freeInputEq: eq } : {}
      });
    }
    if (turn.activeMinutes >= th.longTurnActiveMinutes) {
      const calls = rs.reduce((s, r) => s + r.tools.length, 0);
      const top = [...countTools(rs)].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ${c}`).join(", ");
      findings.push({
        type: "long_turn",
        kind: "observation",
        // #84: explicit — same semantics as before
        severity: "high",
        basis: "measured",
        // observation, not waste — unlike other findings this books no redundant
        // tokens (the summary carries the activity numbers), so consumers summing
        // tokensWasted don't count a healthy turn's whole billing as waste
        tokensWasted: 0,
        turnIndex: turn.index,
        summary: `active ${Math.round(turn.activeMinutes)} min, ${calls} tool calls (${top || "no tools"})`
      });
    }
    const ticks = rs.filter(
      (r) => !r.isRetryCopy && isQuietTick(r.contextSize, r.outputTokens, r.tools.length)
    );
    if (ticks.length >= th.waitLoopTicks) {
      const wasted = ticks.reduce((s, r) => s + r.contextSize, 0);
      findings.push({
        type: "wait_loop",
        kind: "waste",
        severity: ticks.length >= 20 ? "high" : "medium",
        tokensWasted: wasted,
        turnIndex: turn.index,
        basis: "measured",
        summary: `wait-loop: ${ticks.length} quiet rounds re-read ~${formatTokensCompact(wasted)} tok (≤300 tok of output each)`,
        claims: ticks.map((r) => ({
          owner: `round:${r.index}`,
          want: r.contextSize,
          cap: r.contextSize,
          ...pricer.roundRates(r) ?? {}
        }))
      });
    }
    let stallRounds = [];
    const flushStall = () => {
      if (stallRounds.length >= th.loopStreakMin) {
        const stallStart = stallRounds[0];
        const stallEnd = stallRounds[stallRounds.length - 1];
        const stallWasted = stallRounds.reduce((s, r) => s + r.contextSize, 0);
        findings.push({
          type: "stall_streak",
          kind: "waste",
          severity: stallRounds.length >= 5 ? "high" : "medium",
          tokensWasted: stallWasted,
          turnIndex: turn.index,
          basis: "measured",
          summary: `stall: ${stallRounds.length} rounds with no context growth re-read ~${formatTokensCompact(stallWasted)} tok (${short(stallStart.tools.join(", ") || "tool calls", 40)}) ${hhmm(stallStart.timestamp)}–${hhmm(stallEnd.timestamp)}`,
          claims: stallRounds.map((r) => ({
            owner: `round:${r.index}`,
            want: r.contextSize,
            cap: r.contextSize,
            ...pricer.roundRates(r) ?? {}
          }))
        });
      }
      stallRounds = [];
    };
    let stallPrev = 0;
    for (const r of rs) {
      if (r.isRetryCopy) continue;
      if (isStalledRound(stallPrev, r.contextSize, r.outputTokens, r.tools.length)) {
        stallRounds.push(r);
      } else {
        flushStall();
      }
      if (r.contextSize > 0) stallPrev = r.contextSize;
    }
    flushStall();
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.push(...detectCycleFindings(messages, ledger, results));
  const prio = (f) => {
    const i = WASTE_TYPE_PRIORITY.indexOf(f.type);
    return i === -1 ? WASTE_TYPE_PRIORITY.length : i;
  };
  findings.sort(
    (a, b) => prio(a) - prio(b) || order[a.severity] - order[b.severity] || b.tokensWasted - a.tokensWasted
  );
  allocateWaste(findings);
  return findings.map(
    ({ free: _free, claims: _claims, freeUsd: _freeUsd, freeInputEq: _freeInputEq, ...finding }) => finding
  );
}
function sessionWasteTotals(findings, ledger) {
  let tokensWasted = 0;
  let usd = 0;
  let priced = false;
  let partial = false;
  for (const f of findings) {
    if (f.kind !== "waste") continue;
    tokensWasted += f.tokensWasted;
    if (f.tokensWasted > 0 && f.wastedUsd === void 0) partial = true;
    if (f.wastedUsd !== void 0) {
      usd += f.wastedUsd;
      priced = true;
    }
  }
  const cost = ledger.totals.costUsd;
  return {
    tokensWasted,
    ...priced ? { wastedUsd: usd } : {},
    wasteUsdPartial: partial,
    ...priced && cost !== void 0 && cost > 0 ? { wasteShare: usd / cost } : {}
  };
}
function short(s, n) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}
const CYCLE = { minLen: 3, maxLen: 5, minRepeats: 3 };
const MUTATING_TOOLS = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
function resultSignature(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>"
  );
}
function detectCycleFindings(messages, ledger, results, pricer = residencyPricer(ledger)) {
  const findings = [];
  const retryCopies = getRetryCopyMessageIds(messages);
  const msgs = deduplicateByRequestId(messages).filter(
    (m) => m.type === "assistant" && !m.isSidechain && !!m.usage && m.model !== "<synthetic>" && !retryCopies.has(m.uuid)
  );
  const ledgerRounds = ledger.rounds.filter((r) => !r.isRetryCopy);
  if (msgs.length !== ledgerRounds.length) return findings;
  const rounds = msgs.map((m, i) => ({
    turnIndex: ledgerRounds[i].turnIndex,
    roundIndex: ledgerRounds[i].index,
    contextSize: ledgerRounds[i].contextSize,
    timestamp: ledgerRounds[i].timestamp,
    calls: m.toolCalls.map((c) => {
      const res = results.get(c.id);
      const text = res ? resultText(res.content) : "";
      return {
        id: c.id,
        toolName: c.name,
        key: bashStem(normalizeCallKey(c.name, c.input)),
        sig: res ? resultSignature(text) : "",
        tok: res ? estimateTokens(text) : 0
      };
    })
  }));
  const byTurn = /* @__PURE__ */ new Map();
  for (const r of rounds) {
    const list = byTurn.get(r.turnIndex);
    if (list) list.push(r);
    else byTurn.set(r.turnIndex, [r]);
  }
  for (const [turnIndex, rs] of byTurn) {
    for (let L = CYCLE.maxLen; L >= CYCLE.minLen; L--) {
      let hit = false;
      let i = 0;
      while (i + L * CYCLE.minRepeats <= rs.length) {
        let reps = 1;
        const eq = (a, b) => {
          for (let k = 0; k < L; k++) {
            if (rs[a + k].calls.length !== rs[b + k].calls.length || rs[a + k].calls.some((c, j) => c.key !== rs[b + k].calls[j].key)) {
              return false;
            }
          }
          return true;
        };
        while (i + (reps + 1) * L <= rs.length && eq(i, i + reps * L)) reps += 1;
        if (reps >= CYCLE.minRepeats) {
          hit = true;
          const motif = rs.slice(i, i + L).map((r) => short(r.calls.map((c) => c.key).join("+") || "—", 24)).join(" → ");
          const wasted = rs.slice(i + L, i + reps * L).reduce((s, r) => s + r.contextSize, 0);
          findings.push({
            type: "cycle_motif",
            kind: "waste",
            severity: reps >= 4 ? "high" : "medium",
            tokensWasted: wasted,
            turnIndex,
            basis: "measured",
            summary: `cycle: ${motif} — x${reps} repeats re-read ~${formatTokensCompact(wasted)} tok ${hhmm(rs[i].timestamp)}–${hhmm(rs[i + reps * L - 1].timestamp)}`,
            claims: rs.slice(i + L, i + reps * L).map((r) => ({
              owner: `round:${r.roundIndex}`,
              want: r.contextSize,
              cap: r.contextSize,
              ...pricer.roundRatesByIndex(r.roundIndex) ?? {}
            }))
          });
          i += reps * L;
        } else {
          i += 1;
        }
      }
      if (hit) break;
    }
    const byKey = /* @__PURE__ */ new Map();
    for (const r of rs) {
      for (const c of r.calls) {
        if (!c.sig || MUTATING_TOOLS.has(c.toolName)) continue;
        const list = byKey.get(c.key);
        const entry = {
          id: c.id,
          sig: c.sig,
          ts: r.timestamp,
          tok: c.tok,
          rates: pricer.resultRates(r.timestamp.getTime())
        };
        if (list) list.push(entry);
        else byKey.set(c.key, [entry]);
      }
    }
    for (const [key, list] of byKey) {
      if (list.length < 2) continue;
      let best = { len: 1, start: 0, end: 0 };
      let run = 1;
      for (let j = 1; j < list.length; j++) {
        run = list[j].sig && list[j].sig === list[j - 1].sig ? run + 1 : 1;
        if (run > best.len) best = { len: run, start: j - run + 1, end: j };
      }
      if (best.len < 2) continue;
      const repeats = list.slice(best.start + 1, best.end + 1);
      findings.push({
        type: "probe_no_progress",
        kind: "waste",
        severity: "medium",
        tokensWasted: repeats.reduce((s, e) => s + e.tok, 0),
        turnIndex,
        basis: "estimated",
        summary: `probe no progress: ${short(key, 60)} — same result x${best.len}: ${short(list[best.start].sig, 70)}`,
        claims: repeats.map((e) => ({
          owner: `result:${e.id}`,
          want: e.tok,
          cap: e.tok,
          ...e.rates ?? {}
        }))
      });
    }
  }
  return findings;
}
function turnVerdict(findings, rounds, activeMinutes) {
  const types = new Set(findings.map((f) => f.type));
  if (types.has("probe_no_progress")) return "cycle-churning";
  if (types.has("cycle_motif")) return "cycle-progressing";
  if (rounds >= 30 || activeMinutes >= WASTE_THRESHOLDS.longTurnActiveMinutes) return "long-turn";
  return "normal";
}
function parseArgs(argv) {
  const opts = {
    useLast: false,
    rounds: 20,
    subagentMinMinutes: 5,
    minSeverity: "low",
    json: false,
    breakdown: false,
    noCost: false
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
    if (a === "--rounds") {
      opts.rounds = parseInt(value, 10) || 20;
      i = next;
      continue;
    }
    if (a === "--turn") {
      opts.turn = parseInt(value, 10) || void 0;
      i = next;
      continue;
    }
    if (a === "--subagent-min-minutes") {
      opts.subagentMinMinutes = parseInt(value, 10) || 5;
      i = next;
      continue;
    }
    if (a === "--min-severity") {
      opts.minSeverity = value === "medium" || value === "high" ? value : "low";
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
        opts.lastDays = parseInt(value, 10);
        opts.since = lastDaysSince(opts.lastDays);
        i = next;
      } else {
        opts.useLast = true;
        i += 1;
      }
      continue;
    }
    if (a === "--breakdown") {
      opts.breakdown = true;
      i += 1;
      continue;
    }
    if (a === "--no-cost") {
      opts.noCost = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      opts.json = true;
      i += 1;
      continue;
    }
    if (!a.startsWith("--")) opts.sessionPath = a;
    i += 1;
  }
  return opts;
}
function pickNewestSessionFile(dir) {
  if (!fs.existsSync(dir)) return null;
  let newest = null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".jsonl") || e.name.startsWith("agent-")) continue;
    const file = path.join(dir, e.name);
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtime > newest.mtime) newest = { file, mtime };
  }
  return newest?.file ?? null;
}
function resolveProjectDir(arg) {
  const projectsRoot = getProjectsBasePath();
  if (path.basename(arg).startsWith("-")) {
    return path.isAbsolute(arg) ? arg : path.join(projectsRoot, arg);
  }
  return path.join(projectsRoot, encodePath(path.resolve(arg)));
}
function splitSessionPath(file) {
  const rel = path.relative(getProjectsBasePath(), path.resolve(file));
  const [projectId, sessionId] = rel.split(path.sep);
  return { projectId, sessionId: sessionId ? extractSessionId(sessionId) : "" };
}
async function resolveSubagentsFor(projectId, sessionId, messages) {
  const scanner = new ProjectScanner();
  const resolver = new SubagentResolver(scanner);
  return resolver.resolveSubagents(projectId, sessionId, getTaskCalls(messages), messages);
}
const pad = (s, n) => s.length >= n ? s : s + " ".repeat(n - s.length);
const padL = (s, n) => s.length >= n ? s : " ".repeat(n - s.length) + s;
const fmt = (n) => formatTokensDetailed(n);
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dur = (ms) => `${Math.floor(ms / 36e5)}h ${String(Math.floor(ms % 36e5 / 6e4)).padStart(2, "0")}m`;
const VERDICT_LABEL = {
  "cycle-churning": "ЦИКЛ С ВРАЩЕНИЕМ — участки цикла крутятся без продвижения (проба возвращает тот же результат)",
  "cycle-progressing": "ЦИКЛ С ПРОДВИЖЕНИЕМ — diagnose-fix-verify, витки отвечают на вопросы",
  "long-turn": "ДЛИННЫЙ ХОД — много работы, повторяющихся последовательностей нет",
  normal: "ОБЫЧНЫЙ ХОД"
};
function printTurnDeepDive(ledger, findings, messages, turnNo, opts) {
  const turn = ledger.turns.find((t) => t.index === turnNo);
  if (!turn) {
    console.error(`no turn #${turnNo} (session has ${ledger.turns.length})`);
    process.exitCode = 1;
    return;
  }
  const rs = ledger.rounds.filter((r) => r.turnIndex === turnNo);
  const tf = findings.filter((f) => f.turnIndex === turnNo);
  const user = (() => {
    let n = 0;
    for (const m of messages) {
      if (m.isCompactSummary) continue;
      if ((isParsedUserChunkMessage(m) || isParsedTeammateRelayMessage(m)) && !m.isSidechain && ++n === turnNo)
        return m;
    }
    return null;
  })();
  const preview = user ? short(typeof user.content === "string" ? user.content : JSON.stringify(user.content), 110) : "(no user text)";
  const first = rs[0];
  const last = rs[rs.length - 1];
  const span = first ? last.timestamp.getTime() - turn.start.getTime() : 0;
  const verdict = turnVerdict(tf, rs.length, turn.activeMinutes);
  console.log(`=== TURN ${turnNo} ===`);
  console.log(`user  : ${preview}`);
  console.log(
    `span  : ${dur(span)} wall, active ${Math.round(turn.activeMinutes)}m, ${rs.length} rounds, ${rs.reduce((s, r) => s + r.tools.length, 0)} tool calls`
  );
  if (first && last) {
    console.log(
      `ctx   : ${fmt(first.contextSize)} → ${fmt(last.contextSize)} (+${fmt(last.contextSize - first.contextSize)})`
    );
  }
  console.log(`verdict: ${VERDICT_LABEL[verdict]}`);
  console.log("findings:");
  if (tf.length === 0) {
    console.log("  (none)");
  }
  for (const f of tf) {
    console.log(`  [${f.severity}] ${f.type}: ${f.summary}`);
  }
  console.log(`rounds (last ${Math.min(opts.rounds, rs.length)} of ${rs.length}):`);
  for (const r of rs.slice(-opts.rounds)) {
    console.log(
      `  ${padL(String(r.index), 4)} ${pad(hhmm(r.timestamp), 6)} ${padL(fmt(r.contextSize), 9)} ${padL((r.contextDelta >= 0 ? "+" : "") + fmt(r.contextDelta), 9)}  ${short(r.tools.join(","), 48)}`
    );
  }
}
function printReport(file, ledger, findings, subagents, opts) {
  const t = ledger.totals;
  const activeTurns = new Set(ledger.rounds.map((r) => r.turnIndex)).size;
  console.log("=== SESSION ===");
  console.log("file :", path.basename(file));
  console.log(
    `turns: ${activeTurns}  rounds: ${ledger.rounds.length}  active: ${dur(ledger.activeMinutes * 6e4)} (wall ${dur(ledger.durationMs)})`
  );
  console.log("models:", ledger.models.join(", ") || "n/a");
  console.log("billing:", ledger.billing);
  if (t.noUsageRounds > 0) {
    console.log(
      `⚠ ${t.noUsageRounds} rounds have no usage stats — root cause under investigation (#14)`
    );
  }
  if (t.retryCopies > 0) {
    console.log(`ℹ ${t.retryCopies} router-retry copies detected (sums untouched — #15)`);
  }
  if (t.longestTurn) {
    console.log(
      `longest turn: #${t.longestTurn.turn} (active ${Math.round(t.longestTurn.activeMinutes)}m, ${t.longestTurn.rounds} rounds)`
    );
  }
  if (t.costUsd !== void 0 && !opts.noCost) {
    const partial = t.costPartial ? " (partial — unpriced models excluded)" : "";
    console.log("est. cost: $" + t.costUsd.toFixed(2) + partial);
    const wt = sessionWasteTotals(findings, ledger);
    let wasteLine = `waste (non-overlapping): ${fmt(wt.tokensWasted)} tok`;
    if (wt.wasteShare !== void 0) {
      const partialW = wt.wasteUsdPartial ? " (partial — unpriced waste excluded)" : "";
      wasteLine += `  ~$${wt.wastedUsd.toFixed(4)} of $${t.costUsd.toFixed(2)} (${(wt.wasteShare * 100).toFixed(1)}%)${partialW}`;
    }
    console.log(wasteLine);
  }
  console.log();
  console.log("=== TOKENS (billed) ===");
  console.log(`input (uncached)     : ${fmt(t.inputTokens)}`);
  console.log(
    `cache_read (reread)  : ${fmt(t.cacheReadTokens)}  <- whole context re-read EVERY round`
  );
  console.log(`cache_write (new)    : ${fmt(t.cacheCreationTokens)}`);
  console.log(`output               : ${fmt(t.outputTokens)}`);
  console.log(`thinking (billed est.) : ~${fmt(t.thinkingTokens)}`);
  console.log(`TOTAL                : ${fmt(t.billedTokens)}`);
  console.log(`reread share         : ${Math.round(t.rereadShare * 100)}%`);
  console.log();
  if (opts.breakdown) {
    const rows = breakdownFromRounds(ledger.rounds);
    console.log("=== BY MODEL ===");
    console.log(
      `${pad("model", 28)} ${padL("in", 8)} ${padL("cr", 8)} ${padL("cw", 8)} ${padL("out", 8)} ${padL("total", 9)}${opts.noCost ? "" : padL("cost", 10)}`
    );
    for (const b of rows) {
      const cost = opts.noCost || b.costUsd === void 0 ? "" : padL("$" + b.costUsd.toFixed(2), 10);
      console.log(
        `${pad(short(b.model, 28), 28)} ${padL(fmt(b.inputTokens), 8)} ${padL(fmt(b.cacheReadTokens), 8)} ${padL(fmt(b.cacheCreationTokens), 8)} ${padL(fmt(b.outputTokens), 8)} ${padL(fmt(b.billedTokens), 9)}${cost}`
      );
    }
    console.log();
  }
  console.log("=== BY TURN ===");
  console.log(
    `${pad("#", 3)} ${pad("time", 6)} ${padL("dur", 5)} ${padL("context", 9)} ${padL("reread", 9)} ${padL("new", 8)} ${padL("out", 7)} ${pad("think%", 7)}  tools`
  );
  const byTurn = roundsByTurn(ledger.rounds);
  for (const turn of ledger.turns) {
    const rs = byTurn.get(turn.index) ?? [];
    if (rs.length === 0) continue;
    const ctx = rs.filter((r) => r.contextSize > 0).at(-1)?.contextSize ?? 0;
    const reread = rs.reduce((s, r) => s + r.cacheReadTokens, 0);
    const fresh = rs.reduce((s, r) => s + r.inputTokens + r.cacheCreationTokens, 0);
    const out = rs.reduce((s, r) => s + r.outputTokens, 0);
    const think = rs.reduce((s, r) => s + r.thinkingTokens, 0);
    const genTotal = think + out;
    const thinkPct = genTotal > 0 ? Math.round(think / genTotal * 100) : 0;
    const toolCounts = countTools(rs);
    const tools = [...toolCounts].map(([n, c]) => `${n} x${c}`).join(", ");
    console.log(
      `${pad(String(turn.index), 3)} ${pad(hhmm(turn.start), 6)} ${padL(Math.round(turn.activeMinutes) + "m", 5)} ${padL(fmt(ctx), 9)} ${padL(fmt(reread), 9)} ${padL(fmt(fresh), 8)} ${padL(fmt(out), 7)} ${pad(thinkPct + "%", 7)}  ${short(tools, 60)}`
    );
  }
  console.log();
  console.log(`=== ROUNDS (last ${opts.rounds}) ===`);
  console.log(
    `${pad("#", 4)} ${pad("time", 6)} ${padL("context", 9)} ${padL("delta", 9)} ${padL("in", 7)} ${padL("cr", 8)} ${padL("cw", 6)} ${padL("out", 6)}  model`
  );
  for (const r of ledger.rounds.slice(-opts.rounds)) {
    console.log(
      `${pad(String(r.index), 4)} ${pad(hhmm(r.timestamp), 6)} ${padL(fmt(r.contextSize), 9)} ${padL((r.contextDelta >= 0 ? "+" : "") + fmt(r.contextDelta), 9)} ${padL(fmt(r.inputTokens), 7)} ${padL(fmt(r.cacheReadTokens), 8)} ${padL(fmt(r.cacheCreationTokens), 6)} ${padL(fmt(r.outputTokens), 6)}  ${short(r.model, 28)}`
    );
  }
  console.log();
  if (subagents.length > 0) {
    console.log("=== SUBAGENTS ===");
    for (const s of subagents) {
      const slow = s.durationMs > opts.subagentMinMinutes * 6e4;
      const flag = slow ? `  !SLOW >${opts.subagentMinMinutes}min` : "";
      const ongoing = s.isOngoing ? " (ongoing)" : "";
      console.log(
        `${pad(short(s.description ?? s.subagentType ?? s.id, 52), 52)} ${pad(s.subagentType ?? "", 10)} ${padL(dur(s.durationMs), 8)}${flag}${ongoing}  ~${formatTokensCompact(s.metrics?.totalTokens ?? 0)} tok`
      );
    }
    console.log();
  }
  const severityRank = { low: 0, medium: 1, high: 2 };
  const visible = findings.filter(
    (f) => severityRank[f.severity] >= severityRank[opts.minSeverity]
  );
  console.log("=== FINDINGS ===");
  if (visible.length === 0) {
    console.log("(none — clean session)");
  } else {
    for (const f of visible) {
      const turnTag = f.turnIndex === void 0 ? "" : ", turn " + String(f.turnIndex);
      const usdTag = !opts.noCost && f.wastedUsd !== void 0 ? ` ~$${f.wastedUsd.toFixed(4)}` : "";
      const estTag = f.basis === "estimated" ? " (est)" : "";
      console.log(`[${f.type}${turnTag}]${usdTag}${estTag} ${f.summary}`);
    }
  }
  console.log();
  console.log(
    "note: this is observation, not prevention — add deny rules for culprit commands in Claude Code settings."
  );
}
async function main() {
  const raw = process.argv.slice(2);
  if (wantsHelp(raw)) {
    console.log(
      [
        "usage: session-audit <file.jsonl> | --project <dir|encoded> --last [N] [flags]",
        "",
        "flags:",
        "  --rounds N                rounds table length (default 20)",
        "  --turn N                  deep-dive into turn N: verdict «цикл или длинный ход», findings, rounds",
        "  --subagent-min-minutes N  slow-subagent threshold in minutes (default 5)",
        "  --min-severity S          low | medium | high (default low = all)",
        "  --breakdown               per-model token/cost breakdown",
        "  --since DATE              only activity on/after this date (YYYY-MM-DD or YYYYMMDD)",
        "  --until DATE              only activity on/before this date",
        "  --last [N]                no value: analyze newest session of --project;",
        "                            N: only activity of the last N calendar days",
        "  --no-cost                 omit cost estimates",
        "  --json                    machine-readable output"
      ].join("\n")
    );
    return;
  }
  const opts = parseArgs(raw);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  let sessionFile = opts.sessionPath ? path.resolve(opts.sessionPath) : null;
  if (!sessionFile && opts.projectArg) {
    if (!opts.useLast && opts.lastDays === void 0) {
      console.error("--project requires --last (bare, or with a day count: --last N)");
      process.exitCode = 1;
      return;
    }
    const dir = resolveProjectDir(opts.projectArg);
    if (!fs.existsSync(dir)) {
      console.error(`project dir not found: ${dir}`);
      process.exitCode = 1;
      return;
    }
    sessionFile = pickNewestSessionFile(dir);
    if (!sessionFile) {
      console.error(`no .jsonl sessions found in ${dir}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    console.error("usage: session-audit <file.jsonl>  |  session-audit --project <dir> --last");
    process.exitCode = 1;
    return;
  }
  const { projectId, sessionId } = splitSessionPath(sessionFile);
  const messages = await parseJsonlFile(sessionFile);
  const ledger = filterLedgerByDate(buildLedger(messages), opts.since, opts.until);
  const findings = computeFindings(messages, ledger, opts.since, opts.until);
  if (opts.turn) {
    printTurnDeepDive(ledger, findings, messages, opts.turn, opts);
    return;
  }
  let subagents = [];
  try {
    subagents = await resolveSubagentsFor(projectId, sessionId, messages);
  } catch (err) {
    console.error(`(subagent resolution unavailable: ${String(err)})`);
  }
  if (opts.since || opts.until) {
    subagents = subagents.filter((s) => {
      if (opts.since && s.endTime < opts.since) return false;
      if (opts.until && s.startTime > opts.until) return false;
      return true;
    });
  }
  if (opts.json) {
    const subagentSummaries = subagents.map((p) => ({
      id: p.id,
      description: p.description,
      subagentType: p.subagentType,
      durationMs: p.durationMs,
      totalTokens: p.metrics?.totalTokens ?? 0,
      isOngoing: p.isOngoing
    }));
    const totalsOut = { ...ledger.totals };
    if (opts.noCost) {
      delete totalsOut.costUsd;
      delete totalsOut.costPartial;
    }
    const ledgerOut = opts.noCost ? { ...ledger, totals: totalsOut } : ledger;
    const breakdown = opts.breakdown ? breakdownFromRounds(ledger.rounds, !opts.noCost) : void 0;
    const findingsOut = opts.noCost ? findings.map(({ wastedUsd: _usd, tokensWastedInputEq: _eq, ...f }) => f) : findings;
    const wasteOut = sessionWasteTotals(findings, ledger);
    const wasteBlock = opts.noCost ? { tokensWasted: wasteOut.tokensWasted } : wasteOut;
    console.log(
      JSON.stringify(
        {
          file: sessionFile,
          projectId,
          sessionId,
          ledger: ledgerOut,
          findings: findingsOut,
          waste: wasteBlock,
          subagents: subagentSummaries,
          ...breakdown ? { breakdown } : {}
        },
        null,
        2
      )
    );
    return;
  }
  printReport(sessionFile, ledger, findings, subagents, opts);
}
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
export {
  TURN_IDLE_GAP_CAP_MINUTES,
  WASTE_THRESHOLDS,
  WASTE_TYPE_PRIORITY,
  inDateRange as a,
  translateWslMountPath as b,
  bashStem,
  billingFromFlags,
  breakdownFromRounds,
  buildLedger,
  isTurnNumberLine as c,
  computeFindings,
  contextSpikeSummary,
  decodePath as d,
  detectBillingScheme,
  detectCycleFindings,
  dur,
  billedRequestKey$1 as e,
  formatTokensCompact as f,
  filterLedgerByDate,
  getProjectsBasePath as g,
  getRetryCopyMessageIds,
  extractSessionId as h,
  isDirectRun as i,
  isQuietTick,
  lastDaysSince as l,
  normalizeDriveLetter as n,
  normalizeCallKey,
  parseDayBound as p,
  pad,
  padL,
  parseArgs,
  pickNewestSessionFile,
  resolveProjectDir,
  roundCostUsd,
  sessionWasteTotals,
  short,
  splitSessionPath,
  takeFlagValue as t,
  totalsFromRounds,
  turnActiveMinutes,
  turnVerdict,
  wantsHelp as w
};
