import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'node:crypto';
import { ragConfig } from './rag.config.js';

export type RagDb = {
  raw: Database.Database;
  vectorAvailable: boolean;
  ftsAvailable: boolean;
  dimensions: number;
};

let cached: RagDb | undefined;

export function normalizeChunkText(text: string) {
  return text.replace(/\r\n?/g, '\n').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function chunkContentHash(text: string) {
  return createHash('sha256').update(normalizeChunkText(text), 'utf8').digest('hex');
}

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
  if (!hasColumn('content_hash')) raw.exec('ALTER TABLE rag_items ADD COLUMN content_hash TEXT');
  if (vectorAvailable) {
    try {
      const existingVec = raw.prepare("SELECT sql FROM sqlite_master WHERE name='vec_rag_items'").get() as { sql?: string } | undefined;
      if (existingVec?.sql && !new RegExp(`float\\[${dimensions}\\]`).test(existingVec.sql)) {
        raw.exec('DROP TABLE vec_rag_items');
        raw.exec('UPDATE rag_items SET embedded_at=NULL, embedding_dim=NULL');
        console.warn('[rag] vector dimension changed; recreated vec_rag_items and marked chunks for backfill');
      }
      raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_rag_items USING vec0(embedding float[${dimensions}] distance_metric=cosine);`);
      raw.exec('DELETE FROM vec_rag_items WHERE rowid NOT IN (SELECT rowid FROM rag_items)');
    } catch (error) {
      console.warn('[rag] failed to create vec_rag_items virtual table, disabling vector search:', error instanceof Error ? error.message : error);
      vectorAvailable = false;
    }
  }
  // Existing databases may predate exact-content deduplication. Keep the most
  // recent useful copy before adding the unique index.
  const migrateHashes = raw.transaction(() => {
    const rows = raw.prepare('SELECT rowid, * FROM rag_items WHERE content_hash IS NULL').all() as Array<Record<string, unknown> & { rowid: number; chunk_text: string }>;
    const update = raw.prepare('UPDATE rag_items SET content_hash=? WHERE rowid=?');
    for (const row of rows) update.run(chunkContentHash(row.chunk_text), row.rowid);
    const duplicates = raw.prepare(`
      SELECT rowid, conversation_id, content_hash FROM (
        SELECT rowid, conversation_id, content_hash,
          ROW_NUMBER() OVER (PARTITION BY conversation_id, content_hash ORDER BY created_at DESC, importance DESC, CASE role WHEN 'user' THEN 0 ELSE 1 END ASC, rowid DESC) AS position
        FROM rag_items WHERE content_hash IS NOT NULL
      ) WHERE position > 1
    `).all() as Array<{ rowid: number; conversation_id: string; content_hash: string }>;
    const deleteItem = raw.prepare('DELETE FROM rag_items WHERE rowid=?');
    const deleteVec = vectorAvailable ? raw.prepare('DELETE FROM vec_rag_items WHERE rowid=?') : undefined;
    for (const duplicate of duplicates) {
      if (deleteVec) deleteVec.run(BigInt(duplicate.rowid));
      deleteItem.run(duplicate.rowid);
    }
  });
  migrateHashes();
  raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_items_conversation_content_hash ON rag_items(conversation_id, content_hash)');
  let ftsAvailable = false;
  try {
    const existingFts = raw.prepare("SELECT sql FROM sqlite_master WHERE name='fts_rag_items'").get() as { sql?: string } | undefined;
    if (existingFts?.sql && (!/contentless_delete\s*=\s*1/i.test(existingFts.sql) || !/tokenize\s*=\s*'trigram'/i.test(existingFts.sql))) raw.exec('DROP TABLE fts_rag_items');
    raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts_rag_items USING fts5(chunk_text, content='', contentless_delete=1, tokenize='trigram')");
    const sync = raw.transaction(() => {
      raw.exec("INSERT INTO fts_rag_items(fts_rag_items) VALUES('delete-all')");
      const insertFts = raw.prepare('INSERT INTO fts_rag_items(rowid, chunk_text) VALUES (?, ?)');
      const existing = raw.prepare('SELECT rowid, chunk_text FROM rag_items').all() as Array<{ rowid: number; chunk_text: string }>;
      for (const item of existing) insertFts.run(item.rowid, item.chunk_text);
    });
    sync();
    ftsAvailable = true;
  } catch (error) {
    console.warn('[rag] FTS5 unavailable, continuing with vector-only RAG:', error instanceof Error ? error.message : error);
  }
  return { vectorAvailable, ftsAvailable };
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
  const availability = ensureSchema(raw, cfg.embedding.dimensions, vectorAvailable);
  cached = { raw, ...availability, dimensions: cfg.embedding.dimensions };
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
