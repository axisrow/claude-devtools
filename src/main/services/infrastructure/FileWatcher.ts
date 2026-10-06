/**
 * FileWatcher service - Watches for changes in Claude Code project files.
 *
 * Responsibilities:
 * - Watch ~/.claude/projects/ directory for session changes
 * - Watch ~/.claude/todos/ directory for todo changes
 * - Detect new/modified/deleted files
 * - Emit events to notify renderer process
 * - Invalidate cache entries when files change
 * - Detect errors in changed session files and notify NotificationManager
 */

import { type FileChangeEvent, type ParsedMessage } from '@main/types';
import { parseJsonlFile, parseJsonlLine } from '@main/utils/jsonl';
import {
  LoopDetector,
  type LoopIncident,
  StallDetector,
  TurnBudgetDetector,
  type TurnBudgetIncident,
} from '@main/utils/loopDetection';
import {
  extractProjectName,
  getClaudeBasePath,
  getProjectsBasePath,
  getTodosBasePath,
} from '@main/utils/pathDecoder';
import { isTurnBoundary } from '@shared/turnAccounting';
import { createLogger } from '@shared/utils/logger';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { projectPathResolver } from '../discovery/ProjectPathResolver';
import { type ProjectScanner } from '../discovery/ProjectScanner';
import { errorDetector } from '../error/ErrorDetector';
import { createDetectedError, type DetectedError } from '../error/ErrorMessageBuilder';

import { ConfigManager } from './ConfigManager';
import { type DataCache } from './DataCache';
import { LocalFileSystemProvider } from './LocalFileSystemProvider';
import { type NotificationManager } from './NotificationManager';

import type { FileSystemProvider, FsDirent } from './FileSystemProvider';

const logger = createLogger('Service:FileWatcher');

/** Debounce window for file change events */
const DEBOUNCE_MS = 100;
/** Retry delay when watched directories are unavailable or watcher errors occur */
const WATCHER_RETRY_MS = 2000;
/** Synthetic alerts below this billed-token volume are dust — suppressed */
const MIN_NOTIFICATION_TOKENS = 1_000_000;
/** Interval for periodic catch-up scan to detect missed fs.watch events */
const CATCH_UP_INTERVAL_MS = 30_000;
/** Only catch-up scan files modified within this window */
const CATCH_UP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
/** Throttle for runtime cursor writes (crash gap bounded to this window) */
const CATCHUP_CURSOR_WRITE_MS = 120_000;

interface AppendedParseResult {
  messages: ParsedMessage[];
  parsedLineCount: number;
  consumedBytes: number;
}

interface ActiveSessionFile {
  projectId: string;
  sessionId: string;
  subagentId?: string;
}

type DetectorKind = 'loop' | 'stall' | 'turn_budget';

/**
 * Builds the bell notification object for a synthetic-detector incident.
 * Single home of the message templates, trigger names, and the budget color —
 * the live path and the startup replay must produce identical alerts.
 */
function detectorIncidentToError(args: {
  kind: DetectorKind;
  incident: LoopIncident | TurnBudgetIncident;
  filePath: string;
  projectId: string;
  sessionId: string;
  /** live batches start at lastLineCount; the startup replay starts at file start */
  lineNumberBase: number;
  /** live: now; replay: the incident message's own timestamp */
  timestamp: Date;
}): DetectedError {
  const { kind, incident, lineNumberBase, timestamp } = args;
  const common = {
    sessionId: args.sessionId,
    projectId: args.projectId,
    filePath: args.filePath,
    projectName: extractProjectName(args.projectId, incident.cwd),
    // ponytail: approximate — deep link targets toolUseId, line is a fallback
    lineNumber: lineNumberBase + incident.batchIndex + 1,
    timestamp,
    cwd: incident.cwd,
    toolUseId: incident.toolUseId || undefined,
  };
  if (kind === 'turn_budget') {
    const budget = incident as TurnBudgetIncident;
    return createDetectedError({
      ...common,
      source: 'turn_budget',
      message:
        `Turn budget · ${formatTokensCompact(budget.spent)} / ` +
        `${formatTokensCompact(budget.budget)} — turn re-read crossed the ` +
        'limit; tool calls are being denied',
      triggerName: 'Turn budget',
      triggerColor: '#f59e0b',
    });
  }
  const loop = incident as LoopIncident;
  return createDetectedError({
    ...common,
    source: 'loop',
    message:
      kind === 'stall'
        ? `${loop.key} ×${loop.count} · ${formatTokensCompact(loop.tokens)} — context not growing (echo-marker loop)`
        : `${loop.key} ×${loop.count} · ${formatTokensCompact(loop.tokens)} — possible stuck loop`,
    triggerName: kind === 'stall' ? 'Stall detected' : 'Loop detected',
  });
}

export class FileWatcher extends EventEmitter {
  private projectsWatcher: fs.FSWatcher | null = null;
  private todosWatcher: fs.FSWatcher | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private projectsPath: string;
  private todosPath: string;
  private dataCache: DataCache;
  private fsProvider: FileSystemProvider;
  private notificationManager: NotificationManager | null = null;
  private projectScanner: ProjectScanner | null = null;
  private isWatching: boolean = false;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Track last processed line count per file for incremental error detection */
  private lastProcessedLineCount = new Map<string, number>();
  /** Track last processed file size in bytes for append-only parsing optimization */
  private lastProcessedSize = new Map<string, number>();
  /** Active session files tracked for periodic catch-up scan */
  private activeSessionFiles = new Map<string, ActiveSessionFile>();
  /** Timer for periodic catch-up scan */
  private catchUpTimer: NodeJS.Timeout | null = null;
  /** Catch-up cursor file path (injectable for tests) */
  private catchupCursorPath: string;
  /** Timestamp of the last cursor write — throttles runtime cursor advance */
  private lastCursorWriteAt = 0;
  /** Timer for SSH polling mode (replaces fs.watch) */
  private pollingTimer: NodeJS.Timeout | null = null;
  /** Polling interval for SSH mode */
  private static readonly SSH_POLL_INTERVAL_MS = 3000;
  /** Guard to prevent overlapping SSH polling runs */
  private pollingInProgress = false;
  /** Indicates whether the first polling baseline snapshot has completed */
  private sshPollPrimed = false;
  /** Track file sizes for SSH polling change detection */
  private polledFileSizes = new Map<string, number>();
  /** Files currently being processed (concurrency guard) */
  private processingInProgress = new Set<string>();
  /** Files that need reprocessing after current processing completes */
  private pendingReprocess = new Set<string>();
  /** Live tool-call loop detection state, fed from detectErrorsInSessionFile */
  private loopDetector = new LoopDetector();
  private stallDetector = new StallDetector();
  private turnBudgetDetector = new TurnBudgetDetector();
  /** Flag to prevent reuse after disposal */
  private disposed = false;

  constructor(
    dataCache: DataCache,
    projectsPath?: string,
    todosPath?: string,
    fsProvider?: FileSystemProvider
  ) {
    super();
    this.projectsPath = projectsPath ?? getProjectsBasePath();
    this.todosPath = todosPath ?? getTodosBasePath();
    this.dataCache = dataCache;
    this.fsProvider = fsProvider ?? new LocalFileSystemProvider();
    this.catchupCursorPath = path.join(getClaudeBasePath(), 'claude-devtools-catchup.json');
  }

  /**
   * Overrides the catch-up cursor location. The class's convention for
   * optional collaborators — keeps the constructor positional list short.
   */
  setCatchupCursorPath(catchupCursorPath: string): void {
    this.catchupCursorPath = catchupCursorPath;
  }

  /**
   * Sets the NotificationManager for error detection integration.
   * Must be called before start() to enable error notifications.
   */
  setNotificationManager(manager: NotificationManager): void {
    this.notificationManager = manager;
  }

  /**
   * Sets the ProjectScanner for cache invalidation on file changes.
   */
  setProjectScanner(scanner: ProjectScanner): void {
    this.projectScanner = scanner;
  }

  /**
   * Sets the filesystem provider. Used when switching between local and SSH modes.
   */
  setFileSystemProvider(provider: FileSystemProvider): void {
    this.fsProvider = provider;
  }

  // ===========================================================================
  // Watcher Control
  // ===========================================================================

  /**
   * Starts watching the projects and todos directories.
   */
  start(): void {
    if (this.disposed) {
      logger.error('Cannot start disposed FileWatcher');
      return;
    }

    if (this.isWatching) {
      logger.warn('Already watching');
      return;
    }

    this.isWatching = true;
    if (this.fsProvider.type === 'ssh') {
      this.startPollingMode();
    } else {
      this.ensureWatchers();
    }
    this.seedActiveSessionFiles().catch((err) => {
      logger.error('Error seeding active session files:', err);
    });
    this.startCatchUpTimer();
  }

  /**
   * Stops all watchers.
   */
  stop(): void {
    this.isWatching = false;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.projectsWatcher) {
      this.projectsWatcher.close();
      this.projectsWatcher = null;
    }

    if (this.todosWatcher) {
      this.todosWatcher.close();
      this.todosWatcher = null;
    }

    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear catch-up timer
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }

    // Clear SSH polling timer
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.pollingInProgress = false;
    this.sshPollPrimed = false;
    this.polledFileSizes.clear();

    // Clear error detection tracking
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.processingInProgress.clear();
    this.pendingReprocess.clear();
    this.loopDetector.resetAll();
    this.stallDetector.resetAll();
    this.turnBudgetDetector.resetAll();

    logger.info('Stopped watching');
  }

  /**
   * Disposes all resources and prevents reuse.
   * Performs comprehensive cleanup of all timers, watchers, maps, and listeners.
   *
   * After calling dispose(), this FileWatcher cannot be restarted.
   * Use stop() for temporary pausing that can be resumed with start().
   */
  dispose(): void {
    if (this.disposed) {
      logger.warn('FileWatcher already disposed');
      return;
    }

    logger.info('Disposing FileWatcher');

    // 1. Stop watchers and clear timers (uses existing stop() logic)
    this.stop();

    // 2. Clear retry timer (stop() already handles this, but being explicit)
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    // 3. Clear all debounce timers (stop() already handles this)
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // 4. Clear catch-up timer (stop() already handles this)
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }

    // 5. Clear polling timer (stop() already handles this)
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    // 6. Clear all tracking maps (stop() already handles most of these)
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.polledFileSizes.clear();
    this.processingInProgress.clear();
    this.pendingReprocess.clear();

    // 7. Remove all EventEmitter listeners (MUST be last)
    this.removeAllListeners();

    // 8. Mark as disposed
    this.disposed = true;

    logger.info('FileWatcher disposed');
  }

  /**
   * Starts the projects directory watcher.
   */
  private startProjectsWatcher(): void {
    if (this.projectsWatcher) {
      return;
    }

    try {
      if (!fs.existsSync(this.projectsPath)) {
        logger.warn(`FileWatcher: Projects directory does not exist: ${this.projectsPath}`);
        this.scheduleWatcherRetry();
        return;
      }

      this.projectsWatcher = fs.watch(
        this.projectsPath,
        { recursive: true },
        (eventType, filename) => {
          if (filename) {
            this.handleProjectsChange(eventType, filename);
          }
        }
      );
      this.attachWatcherRecovery(this.projectsWatcher, 'projects');

      logger.info(`FileWatcher: Started watching projects at ${this.projectsPath}`);
    } catch (error) {
      logger.error('Error starting projects watcher:', error);
      this.projectsWatcher = null;
      this.scheduleWatcherRetry();
    }
  }

  /**
   * Starts the todos directory watcher.
   */
  private startTodosWatcher(): void {
    if (this.todosWatcher) {
      return;
    }

    try {
      if (!fs.existsSync(this.todosPath)) {
        // Todos directory may not exist yet - that's OK
        this.scheduleWatcherRetry();
        return;
      }

      this.todosWatcher = fs.watch(this.todosPath, (eventType, filename) => {
        if (filename) {
          this.handleTodosChange(eventType, filename);
        }
      });
      this.attachWatcherRecovery(this.todosWatcher, 'todos');

      logger.info(`FileWatcher: Started watching todos at ${this.todosPath}`);
    } catch (error) {
      logger.error('Error starting todos watcher:', error);
      this.todosWatcher = null;
      this.scheduleWatcherRetry();
    }
  }

  private ensureWatchers(): void {
    if (!this.isWatching || this.fsProvider.type === 'ssh') {
      return;
    }

    this.startProjectsWatcher();
    this.startTodosWatcher();

    if (!this.projectsWatcher || !this.todosWatcher) {
      this.scheduleWatcherRetry();
    }
  }

  private scheduleWatcherRetry(): void {
    if (!this.isWatching || this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.ensureWatchers();
    }, WATCHER_RETRY_MS);
  }

  private attachWatcherRecovery(watcher: fs.FSWatcher, watcherType: 'projects' | 'todos'): void {
    watcher.on('error', (error) => {
      logger.error(`FileWatcher: ${watcherType} watcher error:`, error);
      if (watcherType === 'projects') {
        this.projectsWatcher = null;
      } else {
        this.todosWatcher = null;
      }
      this.scheduleWatcherRetry();
    });

    watcher.on('close', () => {
      if (!this.isWatching) {
        return;
      }
      if (watcherType === 'projects') {
        this.projectsWatcher = null;
      } else {
        this.todosWatcher = null;
      }
      this.scheduleWatcherRetry();
    });
  }

  // ===========================================================================
  // SSH Polling Mode
  // ===========================================================================

  /**
   * Starts polling mode for SSH connections.
   * Polls the projects directory for file changes instead of using fs.watch().
   */
  private startPollingMode(): void {
    if (this.pollingTimer) return;

    logger.info('FileWatcher: Starting SSH polling mode');
    const runPoll = (): void => {
      if (this.pollingInProgress) {
        return;
      }

      this.pollingInProgress = true;
      this.pollForChanges()
        .catch((err) => {
          logger.error('Error during SSH polling:', err);
        })
        .finally(() => {
          this.pollingInProgress = false;
        });
    };

    // Prime immediately so newly created sessions appear without waiting a full interval.
    runPoll();
    this.pollingTimer = setInterval(runPoll, FileWatcher.SSH_POLL_INTERVAL_MS);
  }

  /**
   * Polls the projects directory for file changes in SSH mode.
   */
  private async pollForChanges(): Promise<void> {
    try {
      const seenFiles = new Set<string>();
      const projectDirs = await this.fsProvider.readdir(this.projectsPath);
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;

        const projectPath = path.join(this.projectsPath, dir.name);
        let entries: FsDirent[];
        try {
          entries = await this.fsProvider.readdir(projectPath);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

          const fullPath = path.join(projectPath, entry.name);
          seenFiles.add(fullPath);
          try {
            const observedSize =
              typeof entry.size === 'number'
                ? entry.size
                : (await this.fsProvider.stat(fullPath)).size;
            const lastSize = this.polledFileSizes.get(fullPath);
            const relativePath = path.join(dir.name, entry.name);

            if (lastSize === undefined) {
              // First time seeing this file: after baseline, emit add.
              this.polledFileSizes.set(fullPath, observedSize);
              if (this.sshPollPrimed) {
                this.handleProjectsChange('rename', relativePath);
              }
            } else if (observedSize !== lastSize) {
              // File changed
              this.polledFileSizes.set(fullPath, observedSize);
              this.handleProjectsChange('change', relativePath);
            }
          } catch {
            continue;
          }
        }
      }

      // Detect deleted files after baseline is established.
      if (this.sshPollPrimed) {
        const removedFiles: string[] = [];
        for (const trackedPath of this.polledFileSizes.keys()) {
          if (!seenFiles.has(trackedPath)) {
            removedFiles.push(trackedPath);
          }
        }
        for (const removedPath of removedFiles) {
          this.polledFileSizes.delete(removedPath);
          const relativePath = path.relative(this.projectsPath, removedPath);
          if (relativePath && !relativePath.startsWith('..')) {
            this.handleProjectsChange('rename', relativePath);
          }
        }
      } else {
        this.sshPollPrimed = true;
      }
    } catch (err) {
      logger.error('Error polling for changes:', err);
    }
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  /**
   * Handles file change events in the projects directory.
   */
  private handleProjectsChange(eventType: string, filename: string): void {
    try {
      // Memory files: <projectId>/memory/*.md
      if (filename.endsWith('.md')) {
        const parts = filename.split(/[\\/]/).filter(Boolean);
        if (parts.length >= 3 && parts[1] === 'memory') {
          const projectId = parts[0];
          this.debounce(`memory:${filename}`, () => {
            this.emit('memory-change', { projectId });
          });
        }
        return;
      }

      // Ignore other non-JSONL files
      if (!filename.endsWith('.jsonl')) {
        return;
      }

      // Debounce rapid changes to the same file
      this.debounce(filename, () => this.processProjectsChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling projects change:', error);
    }
  }

  /**
   * Process a debounced projects change.
   */
  private async processProjectsChange(eventType: string, filename: string): Promise<void> {
    const fullPath = path.isAbsolute(filename)
      ? path.normalize(filename)
      : path.join(this.projectsPath, filename);
    const relativePath = path.relative(this.projectsPath, fullPath);

    // Ignore events outside of the watched projects root.
    if (relativePath.startsWith('..')) {
      return;
    }

    // Normalize separators to support platform/event source differences.
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    const projectId = parts[0];

    if (!projectId) return;
    const fileExists = await this.fsProvider.exists(fullPath);

    // Determine change type
    let changeType: FileChangeEvent['type'];
    if (eventType === 'rename') {
      changeType = fileExists ? 'add' : 'unlink';
    } else {
      changeType = 'change';
    }

    // Parse session ID and check if it's a subagent
    let sessionId: string | undefined;
    let isSubagent = false;

    // Session file at project root: projectId/sessionId.jsonl
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      sessionId = path.basename(parts[1], '.jsonl');
    }
    // Subagent file: projectId/sessionId/subagents/agent-hash.jsonl
    else if (parts.length === 4 && parts[2] === 'subagents' && parts[3].endsWith('.jsonl')) {
      sessionId = parts[1];
      isSubagent = true;
    }

    if (sessionId) {
      // Invalidate cache
      this.dataCache.invalidateSession(projectId, sessionId);
      this.projectScanner?.invalidateCachesForProject(projectId);
      projectPathResolver.invalidateProject(projectId);
      if (changeType === 'unlink') {
        this.clearErrorTracking(fullPath);
      }

      // Emit event
      const event: FileChangeEvent = {
        type: changeType,
        path: fullPath,
        projectId,
        sessionId,
        isSubagent,
      };

      this.emit('file-change', event);
      logger.info(
        `FileWatcher: ${changeType} ${isSubagent ? 'subagent' : 'session'} - ${relativePath}`
      );

      // Detect errors in changed session files (not deleted files)
      if (changeType !== 'unlink' && this.notificationManager) {
        if (isSubagent) {
          // Only process subagent files if config allows
          const config = ConfigManager.getInstance().getConfig();
          if (config.notifications.includeSubagentErrors) {
            const subagentFilename = path.basename(parts[3], '.jsonl');
            const subagentId = subagentFilename.replace(/^agent-/, '');
            this.activeSessionFiles.set(fullPath, { projectId, sessionId, subagentId });
            this.detectErrorsInSessionFile(projectId, sessionId, fullPath, subagentId).catch(
              (err) => {
                logger.error('Error detecting errors in subagent file:', err);
              }
            );
          }
        } else {
          this.activeSessionFiles.set(fullPath, { projectId, sessionId });
          this.detectErrorsInSessionFile(projectId, sessionId, fullPath).catch((err) => {
            logger.error('Error detecting errors in session file:', err);
          });
        }
      }
    }
  }

  // ===========================================================================
  // Error Detection
  // ===========================================================================

  /**
   * Detects errors in a session file and sends notifications.
   * Uses incremental processing to only check new lines since last check.
   */
  private async detectErrorsInSessionFile(
    projectId: string,
    sessionId: string,
    filePath: string,
    subagentId?: string
  ): Promise<void> {
    if (!this.notificationManager) {
      return;
    }

    // Concurrency guard: if already processing this file, mark for reprocessing
    if (this.processingInProgress.has(filePath)) {
      this.pendingReprocess.add(filePath);
      return;
    }

    this.processingInProgress.add(filePath);
    try {
      // Get the last processed line count for this file
      const lastLineCount = this.lastProcessedLineCount.get(filePath) ?? 0;
      const lastSize = this.lastProcessedSize.get(filePath) ?? 0;
      const fileStats = await this.fsProvider.stat(filePath);
      const currentSize = fileStats.size;

      // Fast path: no size change means no new data
      if (currentSize === lastSize && lastLineCount > 0) {
        return;
      }

      const canUseIncrementalAppend = lastLineCount > 0 && currentSize > lastSize;
      let newMessages: ParsedMessage[] = [];
      let currentLineCount: number;
      let processedSize: number;

      if (canUseIncrementalAppend) {
        const appended = await this.parseAppendedMessages(filePath, lastSize);
        newMessages = appended.messages;
        currentLineCount = lastLineCount + appended.parsedLineCount;
        processedSize = lastSize + appended.consumedBytes;
      } else {
        // Fallback for first-read, truncation, or rewrite scenarios
        this.loopDetector.reset(filePath);
        this.stallDetector.reset(filePath);
        this.turnBudgetDetector.reset(filePath);
        const messages = await parseJsonlFile(filePath);
        currentLineCount = messages.length;
        newMessages = messages.slice(lastLineCount);
        // Re-stat after full parse to capture bytes written during the parse
        const postParseStats = await this.fsProvider.stat(filePath);
        processedSize = postParseStats.size;
      }

      // If no new lines, skip processing
      if (currentLineCount <= lastLineCount) {
        this.lastProcessedSize.set(filePath, processedSize);
        return;
      }

      // Detect errors in new messages
      // Note: We pass the offset-adjusted line numbers to errorDetector
      const errors = await errorDetector.detectErrors(newMessages, sessionId, projectId, filePath);

      // Adjust line numbers to account for the offset and annotate subagent errors
      for (const error of errors) {
        if (error.lineNumber !== undefined) {
          error.lineNumber = error.lineNumber + lastLineCount;
        }
        if (subagentId) {
          error.subagentId = subagentId;
        }
      }

      // Notify for each detected error
      for (const error of errors) {
        await this.notificationManager.addError(error);
      }

      // Live tool-call loop detection — stateful, main sessions only (agent
      // files arrive with subagentId and are excluded), incremental appends
      // only: a first-read/catch-up batch replays whole-file history and
      // would re-notify loops that already ended (live detector, not a
      // report — the CLI analyzers cover the offline case).
      const loopCfg = ConfigManager.getInstance().getConfig().notifications.loopDetection;
      logger.debug(
        `loop gate ${path.basename(filePath)}: enabled=${loopCfg.enabled} ` +
          `threshold=${loopCfg.cycleThreshold} ` +
          `incremental=${canUseIncrementalAppend} newMessages=${newMessages.length} ` +
          `notificationManager=${this.notificationManager ? 'set' : 'null'}`
      );
      // live-detection gate shared by all synthetic detectors: main sessions
      // only (agent files arrive with subagentId and are excluded),
      // incremental appends only — a first-read batch replays whole-file
      // history and would re-fire events that already ended (the offline
      // report lives in runStartupCatchUpScan, which exists to do this safely)
      const liveGate =
        canUseIncrementalAppend && !subagentId && !path.basename(filePath).startsWith('agent-');
      if (loopCfg.enabled && liveGate) {
        const incident = this.loopDetector.feed(filePath, newMessages, loopCfg.cycleThreshold);
        const incidentText = incident ? `${incident.key} x${incident.count}` : 'none';
        logger.debug(`loop feed ${path.basename(filePath)}: incident=${incidentText}`);
        if (incident && incident.tokens >= MIN_NOTIFICATION_TOKENS) {
          await this.notificationManager.addError(
            detectorIncidentToError({
              kind: 'loop',
              incident,
              filePath,
              projectId,
              sessionId,
              lineNumberBase: lastLineCount,
              timestamp: new Date(),
            })
          );
        }

        // Context-stall detection — the tool-call counterpart of the key-based
        // walk above: rounds that make calls yet stop growing the context
        // (echo-marker loops with distinct args). Same gate, same threshold.
        const stallIncident = this.stallDetector.feed(
          filePath,
          newMessages,
          loopCfg.cycleThreshold
        );
        if (stallIncident && stallIncident.tokens >= MIN_NOTIFICATION_TOKENS) {
          await this.notificationManager.addError(
            detectorIncidentToError({
              kind: 'stall',
              incident: stallIncident,
              filePath,
              projectId,
              sessionId,
              lineNumberBase: lastLineCount,
              timestamp: new Date(),
            })
          );
        }
      }

      // Turn-budget mirror of the hook: same transcript, same accounting
      // core, same config field — the bell's number equals the hook's deny
      // number by construction. Edge-triggered: one notification per turn.
      const turnBudgetCfg = ConfigManager.getInstance().getConfig().notifications.turnBudget;
      if (liveGate && turnBudgetCfg.enabled && turnBudgetCfg.maxInputTokensPerTurn > 0) {
        const budgetIncident = this.turnBudgetDetector.feed(
          filePath,
          newMessages,
          turnBudgetCfg.maxInputTokensPerTurn
        );
        if (budgetIncident && budgetIncident.spent >= MIN_NOTIFICATION_TOKENS) {
          await this.notificationManager.addError(
            detectorIncidentToError({
              kind: 'turn_budget',
              incident: budgetIncident,
              filePath,
              projectId,
              sessionId,
              lineNumberBase: lastLineCount,
              timestamp: new Date(),
            })
          );
        }
      }

      // Update the last processed line count
      this.lastProcessedLineCount.set(filePath, currentLineCount);
      this.lastProcessedSize.set(filePath, processedSize);

      if (errors.length > 0) {
        logger.info(`FileWatcher: Detected ${errors.length} errors in ${filePath}`);
      }
    } catch (err) {
      logger.error(`FileWatcher: Error processing session file for errors: ${filePath}`, err);
    } finally {
      this.processingInProgress.delete(filePath);

      // If a reprocess was requested while we were processing, run again
      if (this.pendingReprocess.has(filePath)) {
        this.pendingReprocess.delete(filePath);
        this.detectErrorsInSessionFile(projectId, sessionId, filePath, subagentId).catch((e) => {
          logger.error('Error during reprocessing of session file:', e);
        });
      }
    }
  }

  /**
   * Clears the error detection tracking for a specific file.
   * Call this when a file is deleted or to force re-processing.
   */
  clearErrorTracking(filePath: string): void {
    this.lastProcessedLineCount.delete(filePath);
    this.lastProcessedSize.delete(filePath);
    this.activeSessionFiles.delete(filePath);
    this.loopDetector.reset(filePath);
    this.stallDetector.reset(filePath);
    this.turnBudgetDetector.reset(filePath);
  }

  /**
   * Clears all error detection tracking.
   */
  clearAllErrorTracking(): void {
    this.lastProcessedLineCount.clear();
    this.lastProcessedSize.clear();
    this.activeSessionFiles.clear();
    this.loopDetector.resetAll();
    this.stallDetector.resetAll();
    this.turnBudgetDetector.resetAll();
  }

  /**
   * Parse only newly appended JSONL lines from the given byte offset.
   */
  private async parseAppendedMessages(
    filePath: string,
    startOffset: number
  ): Promise<AppendedParseResult> {
    const parsedMessages: ParsedMessage[] = [];
    const stream = this.fsProvider.createReadStream(filePath, {
      start: startOffset,
      encoding: 'utf8',
    });

    let buffer = '';
    let consumedBytes = 0;
    let parsedLineCount = 0;
    for await (const chunk of stream) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        consumedBytes += Buffer.byteLength(`${rawLine}\n`, 'utf8');
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = parseJsonlLine(line);
          if (parsed) {
            parsedMessages.push(parsed);
            parsedLineCount++;
          }
        } catch {
          // Ignore malformed appended lines; full parse path will recover on next rewrite.
        }
      }
    }

    // Handle final line without trailing newline
    if (buffer.trim()) {
      try {
        const parsed = parseJsonlLine(buffer);
        if (parsed) {
          parsedMessages.push(parsed);
          parsedLineCount++;
          consumedBytes += Buffer.byteLength(buffer, 'utf8');
        }
      } catch {
        // Keep offset pinned until this trailing partial becomes a complete line.
      }
    }

    return {
      messages: parsedMessages,
      parsedLineCount,
      consumedBytes,
    };
  }

  /**
   * Handles file change events in the todos directory.
   */
  private handleTodosChange(eventType: string, filename: string): void {
    try {
      // Only handle JSON files
      if (!filename.endsWith('.json')) {
        return;
      }

      // Debounce rapid changes
      this.debounce(`todos/${filename}`, () => this.processTodosChange(eventType, filename));
    } catch (error) {
      logger.error('Error handling todos change:', error);
    }
  }

  /**
   * Process a debounced todos change.
   */
  private async processTodosChange(eventType: string, filename: string): Promise<void> {
    // Session ID is the filename without extension
    const sessionId = path.basename(filename, '.json');
    const fullPath = path.join(this.todosPath, filename);
    const fileExists = await this.fsProvider.exists(fullPath);

    // Determine change type
    let changeType: FileChangeEvent['type'];
    if (eventType === 'rename') {
      changeType = fileExists ? 'add' : 'unlink';
    } else {
      changeType = 'change';
    }

    // Emit event (we don't have projectId for todos)
    const event: FileChangeEvent = {
      type: changeType,
      path: fullPath,
      sessionId,
      isSubagent: false,
    };

    this.emit('todo-change', event);
    logger.info(`FileWatcher: ${changeType} todo - ${filename}`);
  }

  // ===========================================================================
  // Active Session Seeding
  // ===========================================================================

  /**
   * Walks the projects tree for top-level session files (projectDir/<id>.jsonl).
   * Single source of the session-file filters (.jsonl, agent- skip) shared by
   * seeding, catch-up discovery, and the startup replay. Returns null when the
   * top-level read fails — callers must not treat that as "no files": the
   * startup replay keeps its cursor behind so the window is retried.
   */
  private async listSessionFiles(options?: {
    includeAgentFiles?: boolean;
  }): Promise<{ fullPath: string; projectId: string; sessionId: string; size?: number }[] | null> {
    interface SessionFile {
      fullPath: string;
      projectId: string;
      sessionId: string;
      size?: number;
    }
    const files: SessionFile[] = [];
    let dirs: FsDirent[];
    try {
      dirs = await this.fsProvider.readdir(this.projectsPath);
    } catch (err) {
      logger.error('FileWatcher: Error listing projects directory:', err);
      return null;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let entries: FsDirent[];
      try {
        entries = await this.fsProvider.readdir(path.join(this.projectsPath, dir.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        // agent- files are subagent transcripts: the replay and discovery
        // skip them, but seeding keeps tracking them (SSH polling mode has
        // no fs.watch to catch their appends otherwise)
        if (entry.name.startsWith('agent-') && !options?.includeAgentFiles) continue;
        files.push({
          fullPath: path.join(this.projectsPath, dir.name, entry.name),
          projectId: dir.name,
          sessionId: path.basename(entry.name, '.jsonl'),
          size: typeof entry.size === 'number' ? entry.size : undefined,
        });
      }
    }
    return files;
  }

  /**
   * Seeds activeSessionFiles with recently modified .jsonl files so the
   * catch-up scan can detect growth in sessions that were already active
   * before the FileWatcher started.
   */
  private async seedActiveSessionFiles(): Promise<void> {
    const now = Date.now();
    try {
      if (!(await this.fsProvider.exists(this.projectsPath))) {
        return;
      }

      for (const file of (await this.listSessionFiles({ includeAgentFiles: true })) ?? []) {
        try {
          const stats = await this.fsProvider.stat(file.fullPath);
          if (now - stats.mtimeMs <= CATCH_UP_MAX_AGE_MS) {
            this.activeSessionFiles.set(file.fullPath, {
              projectId: file.projectId,
              sessionId: file.sessionId,
            });
          }
        } catch {
          continue;
        }
      }

      if (this.activeSessionFiles.size > 0) {
        logger.info(`FileWatcher: Seeded ${this.activeSessionFiles.size} active session files`);
      }
    } catch (err) {
      logger.error('Error seeding active session files:', err);
    }
  }

  // ===========================================================================
  // Catch-Up Scan
  // ===========================================================================

  /**
   * Starts the periodic catch-up timer to detect file growth missed by fs.watch.
   * FSEvents on macOS can coalesce, delay, or drop events. This timer polls
   * tracked active session files every CATCH_UP_INTERVAL_MS to detect unprocessed growth.
   */
  private startCatchUpTimer(): void {
    if (this.catchUpTimer) {
      return;
    }

    this.catchUpTimer = setInterval(() => {
      // Advance the cursor only after the scan certifies the window —
      // advancing first would mark unprocessed growth as processed on a kill
      this.runCatchUpScan()
        .then(() => this.advanceCatchupCursorThrottled())
        .catch((err) => {
          logger.error('Error during catch-up scan:', err);
        });
    }, CATCH_UP_INTERVAL_MS);
  }

  /**
   * Scans active session files for unprocessed growth.
   * Only checks files modified within the last hour.
   */
  private async runCatchUpScan(): Promise<void> {
    if (!this.notificationManager) {
      return;
    }

    const now = Date.now();

    // Discovery sweep: fs.watch can drop events for brand-new files (macOS
    // coalesces directory creation and may deliver a null filename, which is
    // discarded), and only event-seen files ever enter activeSessionFiles.
    // Walk the projects tree for untracked session files so nothing is missed;
    // stale files are evicted by the mtime guard in the loop below.
    try {
      for (const file of (await this.listSessionFiles()) ?? []) {
        if (this.activeSessionFiles.has(file.fullPath)) continue;
        this.activeSessionFiles.set(file.fullPath, {
          projectId: file.projectId,
          sessionId: file.sessionId,
        });
        // Baseline silently: the file's history predates this watcher, so
        // the bell must only ring for calls that happen after discovery.
        // Pin the size cursor; line count is a >0 placeholder — the byte
        // offset is the real cursor for incremental appends.
        try {
          const observed = file.size ?? (await this.fsProvider.stat(file.fullPath)).size;
          this.lastProcessedSize.set(file.fullPath, observed);
          this.lastProcessedLineCount.set(file.fullPath, 1);
        } catch {
          this.activeSessionFiles.delete(file.fullPath);
        }
      }
    } catch (err) {
      logger.error('FileWatcher: Error discovering session files during catch-up:', err);
    }

    if (this.activeSessionFiles.size === 0) {
      return;
    }

    for (const [filePath, info] of this.activeSessionFiles) {
      try {
        const stats = await this.fsProvider.stat(filePath);

        // Skip files not modified recently
        if (now - stats.mtimeMs > CATCH_UP_MAX_AGE_MS) {
          this.activeSessionFiles.delete(filePath);
          continue;
        }

        const lastSize = this.lastProcessedSize.get(filePath) ?? 0;
        if (stats.size > lastSize) {
          logger.info(`FileWatcher: Catch-up scan detected growth in ${filePath}`);
          await this.detectErrorsInSessionFile(
            info.projectId,
            info.sessionId,
            filePath,
            info.subagentId
          );
        }
      } catch (err) {
        // File may have been deleted between iterations
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.activeSessionFiles.delete(filePath);
          this.clearErrorTracking(filePath);
        } else {
          logger.error(`FileWatcher: Error during catch-up stat for ${filePath}:`, err);
        }
      }
    }
  }

  // ===========================================================================
  // Startup Catch-Up Scan
  // ===========================================================================

  /**
   * Reads the catch-up cursor (epoch ms): everything at or before it was
   * processed by a previous startup scan or by live watching. Missing or
   * corrupt cursor file = no cursor yet.
   */
  private readCatchupCursor(): number | null {
    try {
      // ENOENT lands in the catch — no existsSync double-stat
      const parsed = JSON.parse(fs.readFileSync(this.catchupCursorPath, 'utf8')) as {
        scannedUntil?: number;
      };
      return typeof parsed.scannedUntil === 'number' ? parsed.scannedUntil : null;
    } catch {
      return null;
    }
  }

  private writeCatchupCursor(epochMs: number): void {
    try {
      // Atomic tmp+rename: a torn write must not read as "no cursor" and
      // silently re-baseline away the crash gap. No mkdirSync: the dir is
      // ~/.claude (or an override root), it must exist for the app to work.
      const tmp = `${this.catchupCursorPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ scannedUntil: epochMs }), 'utf8');
      fs.renameSync(tmp, this.catchupCursorPath);
      this.lastCursorWriteAt = Date.now();
    } catch (err) {
      logger.error('FileWatcher: Error writing catch-up cursor:', err);
    }
  }

  /**
   * Advances the cursor during live operation so the next startup's scan
   * window only covers the crash gap, not the whole uptime — replaying
   * uptime would re-fire loop incidents (the toolUseId dedup in
   * NotificationManager exempts loops).
   */
  private advanceCatchupCursorThrottled(): void {
    // SSH watchers share the app-global cursor: advancing it from a remote
    // context would certify local files nobody has processed.
    if (this.fsProvider.type !== 'local') {
      return;
    }
    if (Date.now() - this.lastCursorWriteAt < CATCHUP_CURSOR_WRITE_MS) {
      return;
    }
    this.writeCatchupCursor(Date.now());
  }

  /**
   * Offline replay of the window since the previous run: session files
   * modified while the app was closed are fed through throwaway detector
   * instances and the incidents land in the bell without native toasts.
   * First run (no cursor) baselines silently — nothing counts as "new" yet.
   *
   * Invoked once per app launch from index.ts, AFTER setNotificationManager —
   * deliberately not from start(): start() re-enters on SSH connects and
   * context switches, and this cursor is app-global.
   */
  async runStartupCatchUpScan(): Promise<void> {
    const scannedUntil = this.readCatchupCursor();
    if (scannedUntil === null) {
      this.writeCatchupCursor(Date.now());
      return;
    }

    const scanStartedAt = Date.now();
    const cfg = ConfigManager.getInstance().getConfig();
    const loopCfg = cfg.notifications.loopDetection;
    const budgetCfg = cfg.notifications.turnBudget;
    const loopEnabled = loopCfg.enabled;
    const budgetEnabled = budgetCfg.enabled && budgetCfg.maxInputTokensPerTurn > 0;
    if (!loopEnabled && !budgetEnabled) {
      this.writeCatchupCursor(scanStartedAt);
      return;
    }

    // Throwaway detectors: replay state must never mix with live per-file state.
    const loopDetector = new LoopDetector();
    const stallDetector = new StallDetector();
    const budgetDetector = new TurnBudgetDetector();

    const incidents: { error: DetectedError; timestamp: number }[] = [];
    const collectIncident = (
      kind: DetectorKind,
      incident: LoopIncident | TurnBudgetIncident,
      file: { fullPath: string; projectId: string; sessionId: string },
      messages: ParsedMessage[],
      lineNumberBase: number
    ): void => {
      const tokens = 'tokens' in incident ? incident.tokens : incident.spent;
      if (tokens < MIN_NOTIFICATION_TOKENS) return;
      const timestamp = messages[incident.batchIndex]?.timestamp ?? new Date(scanStartedAt);
      // pre-cursor incidents were already notified by the previous run
      if (timestamp.getTime() <= scannedUntil) return;
      incidents.push({
        timestamp: timestamp.getTime(),
        error: detectorIncidentToError({
          kind,
          incident,
          filePath: file.fullPath,
          projectId: file.projectId,
          sessionId: file.sessionId,
          lineNumberBase,
          timestamp,
        }),
      });
    };

    const sessionFiles = await this.listSessionFiles();
    if (sessionFiles === null) {
      // The tree is unreadable — the window is not certified, keep the cursor
      // behind so the next launch retries it.
      logger.error('FileWatcher: Startup catch-up skipped, projects tree unreadable');
      return;
    }

    for (const file of sessionFiles) {
      // One unreadable file must not abort the replay for all the others.
      try {
        const stats = await this.fsProvider.stat(file.fullPath);
        if (stats.mtimeMs <= scannedUntil) continue;

        // ponytail: full-file replay per window file — fine while windows
        // are crash/overnight sized; add a per-file byte cursor if multi-week
        // offline gaps ever make this noticeable
        const appended = await this.parseAppendedMessages(file.fullPath, 0);

        // Anchor the window at the last turn boundary at-or-before the cursor:
        // the turn in progress at app close must be counted from its start, or
        // the budget undercounts and the crossing is missed. Post-launch
        // messages are excluded — the live watcher owns them.
        let startIdx = 0;
        for (let i = 0; i < appended.messages.length; i++) {
          const msg = appended.messages[i];
          if (isTurnBoundary(msg) && msg.timestamp.getTime() <= scannedUntil) {
            startIdx = i;
          }
        }
        // Window from the anchor to launch time. The pre-cursor tail of the
        // turn in progress at close is included so the budget counts the
        // full turn; incidents anchored to pre-cursor messages were already
        // notified by the previous run and are dropped at collection.
        const windowAll = appended.messages
          .slice(startIdx)
          .filter((m) => m.timestamp.getTime() <= scanStartedAt);
        if (windowAll.length === 0) continue;

        // Feed per turn: a detector feed returns at most one incident, and a
        // long offline gap can hold several crossings. Detector state is
        // per-file and persists across feeds, so streaks survive chunking.
        let chunkStart = 0;
        for (let i = 1; i <= windowAll.length; i++) {
          if (i !== windowAll.length && !isTurnBoundary(windowAll[i])) continue;
          const chunkBase = startIdx + chunkStart;
          const chunk = windowAll.slice(chunkStart, i);
          chunkStart = i;
          if (loopEnabled) {
            const incident = loopDetector.feed(file.fullPath, chunk, loopCfg.cycleThreshold);
            if (incident) collectIncident('loop', incident, file, chunk, chunkBase);
            const stall = stallDetector.feed(file.fullPath, chunk, loopCfg.cycleThreshold);
            if (stall) collectIncident('stall', stall, file, chunk, chunkBase);
          }
          if (budgetEnabled) {
            const budget = budgetDetector.feed(
              file.fullPath,
              chunk,
              budgetCfg.maxInputTokensPerTurn
            );
            if (budget) collectIncident('turn_budget', budget, file, chunk, chunkBase);
          }
        }
      } catch (err) {
        logger.error(`FileWatcher: Startup catch-up failed to replay ${file.fullPath}:`, err);
      }
    }

    // The scan is invoked from index.ts after setNotificationManager — the
    // guard is defensive; a missing manager must not lose the cursor advance.
    if (this.notificationManager && incidents.length > 0) {
      incidents.sort((a, b) => a.timestamp - b.timestamp);
      for (const { error } of incidents) {
        await this.notificationManager.addError(error, { silent: true });
      }
      logger.info(
        `FileWatcher: Startup catch-up scan found ${incidents.length} incident(s) since ` +
          new Date(scannedUntil).toISOString()
      );
    }
    // Never regress a newer value the 30s tick wrote while this scan ran.
    this.writeCatchupCursor(Math.max(scanStartedAt, this.lastCursorWriteAt));
  }

  // ===========================================================================
  // Debouncing
  // ===========================================================================

  /**
   * Debounce a function call for a specific key.
   */
  private debounce(key: string, fn: () => void): void {
    // Clear existing timer for this key
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS);

    this.debounceTimers.set(key, timer);
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  /**
   * Returns whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Returns watched paths.
   */
  getWatchedPaths(): { projects: string; todos: string } {
    return {
      projects: this.projectsPath,
      todos: this.todosPath,
    };
  }
}
