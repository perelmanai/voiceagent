import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDb } from "./db.ts";

test("legacy action history keeps its Claude provider after migration", () => {
  const originalDirectory = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), "aural-agent-db-test-"));
  mkdirSync(join(workspace, "data"));
  const legacy = new Database(join(workspace, "data", "aural.db"));
  legacy.exec(`CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL,
    result TEXT, error TEXT, session_code TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, finished_at INTEGER
  ); INSERT INTO agent_runs (id, task, status, created_at) VALUES ('legacy', 'Find coffee', 'done', 1);`);
  legacy.close();
  let migrated;
  try {
    process.chdir(workspace);
    migrated = getDb();
    assert.equal(migrated.prepare("SELECT provider FROM agent_runs WHERE id = 'legacy'").get().provider, "claude");
    migrated.prepare("INSERT INTO agent_runs (id,task,provider,status,created_at) VALUES (?,?,?,?,?)").run("new", "Find coffee", "codex", "running", 2);
    assert.equal(getDb().prepare("SELECT provider FROM agent_runs WHERE id = 'new'").get().provider, "codex");
    assert.equal(getDb(), migrated);
  } finally {
    process.chdir(originalDirectory);
    migrated?.close();
    delete globalThis.__auralDb;
    rmSync(workspace, { recursive: true, force: true });
  }
});
