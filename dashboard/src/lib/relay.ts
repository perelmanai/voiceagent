import fs from "fs";
import path from "path";
import os from "os";

export type RelayLine = { text: string; ts: number };

type Entry = RelayLine & { id: string };
type EntryListener = (entry: Entry) => void;

const DIR = path.join(os.tmpdir(), "aural-relay");
fs.mkdirSync(DIR, { recursive: true });

// Keep listeners on globalThis so they survive Next.js dev hot-reloads in the
// same process. Without this, ingest and stream can miss each other even when
// they share a worker.
const globalRelay = globalThis as typeof globalThis & {
  __auralRelayListeners?: Map<string, Set<EntryListener>>;
};
const listeners =
  globalRelay.__auralRelayListeners ??
  (globalRelay.__auralRelayListeners = new Map());

function filePath(code: string): string {
  return path.join(DIR, `${code}.jsonl`);
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function notify(code: string, entry: Entry): void {
  listeners.get(code)?.forEach((fn) => {
    try {
      fn(entry);
    } catch {
      // subscriber threw — don't break others
    }
  });
}

/** Append a line for this code; visible to all processes on this machine. */
export function publish(code: string, line: RelayLine): void {
  const key = normalizeCode(code);
  const entry: Entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...line,
  };

  // Same-process delivery — immediate and avoids macOS fs.watch gaps.
  notify(key, entry);

  // Cross-process fallback for Turbopack dev workers that don't share memory.
  fs.appendFileSync(filePath(key), JSON.stringify(entry) + "\n");
}

/**
 * Watch for new lines appended for this code.
 * Skips lines that existed before subscribe() was called.
 * Returns an unsubscribe function.
 */
export function subscribe(
  code: string,
  fn: (line: RelayLine) => void
): () => void {
  const key = normalizeCode(code);
  const file = filePath(key);

  if (!fs.existsSync(file)) fs.writeFileSync(file, "");

  const seen = new Set<string>();
  const deliver = (entry: Entry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    fn({ text: entry.text, ts: entry.ts });
  };

  const set = listeners.get(key) ?? new Set<EntryListener>();
  set.add(deliver);
  listeners.set(key, set);

  let offset = fs.statSync(file).size;

  const readNew = () => {
    try {
      const size = fs.statSync(file).size;
      if (size <= offset) return;

      const buf = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;

      for (const raw of buf.toString("utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          deliver(JSON.parse(raw) as Entry);
        } catch {
          // malformed line — skip
        }
      }
    } catch {
      // stat/read race — next poll will catch up
    }
  };

  // fs.watch is unreliable on macOS; poll as the cross-process backstop.
  const poll = setInterval(readNew, 100);

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(file, readNew);
  } catch {
    // polling alone is enough
  }

  return () => {
    clearInterval(poll);
    watcher?.close();
    set.delete(deliver);
    if (set.size === 0) listeners.delete(key);
  };
}
