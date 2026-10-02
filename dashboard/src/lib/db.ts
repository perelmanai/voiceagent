import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// SQLite lives in dashboard/data/ (gitignored). WAL mode keeps concurrent
// route-handler reads from blocking on writes. The handle is cached on
// globalThis so Next.js dev hot-reloads reuse it instead of leaking handles.
const globalDb = globalThis as typeof globalThis & {
  __auralDb?: Database.Database;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                     -- preference | fact | person | place | plan | interest
  category TEXT NOT NULL DEFAULT '',      -- freeform grouping: food, travel, work, ...
  content TEXT NOT NULL,                  -- canonical statement, e.g. "User loves spicy tonkotsu ramen"
  entities TEXT NOT NULL DEFAULT '[]',    -- JSON array of entity names mentioned
  source_text TEXT NOT NULL DEFAULT '',   -- transcript snippet this came from
  session_code TEXT NOT NULL DEFAULT '',  -- pairing code of the session that produced it
  embedding BLOB,                         -- Float32Array(768); null if embedding failed
  salience REAL NOT NULL DEFAULT 0.5,     -- 0..1 importance assigned by the extractor
  reinforcements INTEGER NOT NULL DEFAULT 1, -- times this fact has resurfaced
  access_count INTEGER NOT NULL DEFAULT 0,   -- times recall() returned it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, entities, category,
  content='memories', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, entities, category)
  VALUES (new.rowid, new.content, new.entities, new.category);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, entities, category)
  VALUES ('delete', old.rowid, old.content, old.entities, old.category);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, entities, category)
  VALUES ('delete', old.rowid, old.content, old.entities, old.category);
  INSERT INTO memories_fts(rowid, content, entities, category)
  VALUES (new.rowid, new.content, new.entities, new.category);
END;

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  status TEXT NOT NULL,                   -- running | done | error | cancelled
  result TEXT,
  error TEXT,
  session_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- thought | tool | observation | final | error
  label TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, n);
`;

export function getDb(): Database.Database {
  if (globalDb.__auralDb) {
    migrateAgentProvider(globalDb.__auralDb);
    return globalDb.__auralDb;
  }

  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(path.join(dir, "aural.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateAgentProvider(db);

  globalDb.__auralDb = db;
  return db;
}

// Also run on a cached connection so upgrading during dev hot reload works.
const migratedConnections = new WeakSet<Database.Database>();
function migrateAgentProvider(db: Database.Database): void {
  if (migratedConnections.has(db)) return;
  const columns = db.pragma("table_info(agent_runs)") as { name: string }[];
  if (!columns.some((column) => column.name === "provider")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  }
  migratedConnections.add(db);
}
