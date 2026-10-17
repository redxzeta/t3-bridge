import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type State = Database.Database;

export function openState(directory: string): State {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const db = new Database(join(directory, "gateway.sqlite"));
  chmodSync(join(directory, "gateway.sqlite"), 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS upstream_oauth_state (
      instance TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (instance, kind)
    );
  `);
  return db;
}

export function readRecord<T>(db: State, instance: string, kind: string): T | undefined {
  const row = db.prepare("SELECT value FROM upstream_oauth_state WHERE instance = ? AND kind = ?").get(instance, kind) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : undefined;
}

export function writeRecord(db: State, instance: string, kind: string, value: unknown): void {
  db.prepare("INSERT INTO upstream_oauth_state (instance, kind, value) VALUES (?, ?, ?) ON CONFLICT(instance, kind) DO UPDATE SET value = excluded.value")
    .run(instance, kind, JSON.stringify(value));
}

export function deleteRecord(db: State, instance: string, kind: string): void {
  db.prepare("DELETE FROM upstream_oauth_state WHERE instance = ? AND kind = ?").run(instance, kind);
}
