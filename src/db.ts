/**
 * db — the derived SQLite index (better-sqlite3 + sqlite-vec).
 *
 * The markdown corpus is canonical; this DB is a rebuildable index. Schema:
 *   chunks         — one row per markdown section, with temporal/lifecycle metadata
 *   chunks_vec     — sqlite-vec virtual table holding the 384-dim embeddings
 *   entities       — optional named entities (powers the graph-assist re-rank)
 *   relations      — optional typed edges between entities
 *   chunk_entities — which chunks mention which entities
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import type { Config } from "./config.js";

export type DB = Database.Database;

let cached: DB | null = null;

export function getDb(config: Config): DB {
  if (cached) return cached;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  // sqlite-vec's load() Db type is its own union; better-sqlite3's db is valid.
  (loadSqliteVec as (d: unknown) => void)(db);
  migrate(db);
  cached = db;
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path     TEXT    NOT NULL,
      heading       TEXT,
      content       TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      last_accessed INTEGER,
      access_count  INTEGER NOT NULL DEFAULT 0,
      importance    REAL    NOT NULL DEFAULT 0.5,
      superseded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[384] distance_metric=cosine
    );

    CREATE TABLE IF NOT EXISTS entities (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      type TEXT
    );
    CREATE TABLE IF NOT EXISTS relations (
      from_id INTEGER NOT NULL,
      to_id   INTEGER NOT NULL,
      type    TEXT,
      UNIQUE(from_id, to_id, type)
    );
    CREATE TABLE IF NOT EXISTS chunk_entities (
      chunk_id  INTEGER NOT NULL,
      entity_id INTEGER NOT NULL,
      UNIQUE(chunk_id, entity_id)
    );
  `);
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/** sqlite-vec expects embeddings as a raw float32 BLOB. */
export function toFloat32(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
