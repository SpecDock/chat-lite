import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { ragConfig } from './rag.config.js';

export type RagDb = {
  raw: Database.Database;
  vectorAvailable: boolean;
  dimensions: number;
};

let cached: RagDb | undefined;

function ensureSchema(raw: Database.Database, dimensions: number, vectorAvailable: boolean) {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS rag_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL DEFAULT 'text',
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      embedded_at TEXT,
      embedding_dim INTEGER,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      last_injected_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rag_items_user_message ON rag_items(user_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_rag_items_user_created ON rag_items(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rag_items_conversation ON rag_items(conversation_id);
  `);
  const columns = raw.prepare('PRAGMA table_info(rag_items)').all() as Array<{ name: string }>;
  const hasColumn = (name: string) => columns.some(column => column.name === name);
  if (!hasColumn('hit_count')) raw.exec('ALTER TABLE rag_items ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('last_hit_at')) raw.exec('ALTER TABLE rag_items ADD COLUMN last_hit_at TEXT');
  if (!hasColumn('last_injected_at')) raw.exec('ALTER TABLE rag_items ADD COLUMN last_injected_at TEXT');
  if (vectorAvailable) {
    try {
      raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_rag_items USING vec0(embedding float[${dimensions}] distance_metric=cosine);`);
    } catch (error) {
      console.warn('[rag] failed to create vec_rag_items virtual table, disabling vector search:', error instanceof Error ? error.message : error);
      vectorAvailable = false;
    }
  }
}

export function ragDb(): RagDb {
  if (cached) return cached;
  const cfg = ragConfig();
  const dbPath = cfg.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  let vectorAvailable = false;
  try {
    sqliteVec.load(raw);
    vectorAvailable = true;
    console.info('[rag] sqlite-vec extension loaded');
  } catch (error) {
    vectorAvailable = false;
    console.warn('[rag] sqlite-vec load failed, falling back to metadata-only indexing:', error instanceof Error ? error.message : error);
  }
  ensureSchema(raw, cfg.embedding.dimensions, vectorAvailable);
  cached = { raw, vectorAvailable, dimensions: cfg.embedding.dimensions };
  return cached;
}

export function closeRagDb() {
  if (!cached) return;
  try {
    cached.raw.close();
  } catch {
    // ignore close errors
  }
  cached = undefined;
}

export function ragFileExists(path: string) {
  return existsSync(path);
}
