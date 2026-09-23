/**
 * Tool-call identity for loop/repeat detection, shared by the CLI analyzers
 * (analyzeSession, sessionInventory), the live LoopDetector (FileWatcher) and
 * the renderer's Visible Context loop category (contextTracker).
 */

/**
 * Coerces a tool input value to its text form: strings pass through, nullish
 * collapse to empty, everything else is JSON — so `5` and `"5"` stay distinct.
 * ponytail: normalization is a heuristic — same command/file/pattern counts as a repeat
 */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}

const squash = (v: unknown): string => asText(v).replace(/\s+/g, ' ').trim();

/** Canonical identity of a tool call: same command/file/pattern = same key. */
export function normalizeCallKey(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return `Bash|${squash(input.command)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${name}|${asText(input.file_path)}`;
    case 'Grep':
    case 'Glob':
      return `${name}|${asText(input.pattern)}|${asText(input.path)}`;
    case 'Skill':
      return `Skill|${asText(input.skill)}`;
    case 'Task':
    case 'Agent':
      return `Task|${asText(input.description) || asText(input.prompt)}`;
    default:
      // own top-level keys, sorted — a replacer array would recurse and flatten
      // nested objects to {}, colliding keys of calls differing only in nesting
      return `${name}|${JSON.stringify(
        Object.fromEntries(
          Object.keys(input)
            .sort((a, b) => a.localeCompare(b))
            .map((k) => [k, input[k]])
        )
      )}`;
  }
}

/**
 * Bash key without its pipe tail — hundreds of `git show X | wc -l`-style
 * variants are ONE re-read loop.
 * ponytail: naive pipe cut — pipes inside quoted patterns merge, accepted
 */
export function bashStem(key: string): string {
  if (!key.startsWith('Bash|')) return key;
  const pipe = key.indexOf('|', 5);
  return pipe === -1 ? key : key.slice(0, pipe).trimEnd();
}
