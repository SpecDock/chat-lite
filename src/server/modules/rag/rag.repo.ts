import { ragDb } from './rag-db.js';
import { chunkContentHash, normalizeChunkText } from './rag-db.js';
import { now } from '../../core/db.js';

export type RagItemRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  role: string;
  chunk_index: number;
  chunk_text: string;
  chunk_type: string;
  importance: number;
  created_at: string;
  embedded_at: string | null;
  embedding_dim: number | null;
  hit_count: number;
  last_hit_at: string | null;
  last_injected_at: string | null;
  content_hash: string | null;
};

export type RagItemWithRowid = RagItemRow & { rowid: number };

export type ChunkInsert = {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  chunkIndex: number;
  chunkText: string;
  chunkType?: string;
  importance?: number;
  createdAt: string;
  embedding?: Float32Array | null;
  dimensions?: number;
};

export type RagCandidate = {
  rowid: number;
  distance: number;
  item: RagItemRow;
};

export type KeywordCandidate = { rowid: number; rank: number; item: RagItemRow };

function vectorBuffer(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deleteMessageChunks(userId: string, messageId: string) {
  const { raw, vectorAvailable, ftsAvailable } = ragDb();
  const rows = raw.prepare('SELECT rowid, id, chunk_text FROM rag_items WHERE user_id=? AND message_id=?').all(userId, messageId) as Array<{ rowid: number; id: string; chunk_text: string }>;
  if (!rows.length) return 0;
  const tx = raw.transaction((items: typeof rows) => {
    for (const item of items) {
      if (vectorAvailable) raw.prepare('DELETE FROM vec_rag_items WHERE rowid=?').run(BigInt(item.rowid));
      if (ftsAvailable) raw.prepare('DELETE FROM fts_rag_items WHERE rowid=?').run(item.rowid);
      raw.prepare('DELETE FROM rag_items WHERE id=?').run(item.id);
    }
  });
  tx(rows);
  return rows.length;
}

// Conversation-scoped cleanup. Removes both rag_items rows and their matching
// vec_rag_items rowids for the given conversation_id. Mirrors deleteMessageChunks
// semantics so it can be safely wired into conversation deletion.
export function deleteConversationChunks(conversationId: string): number {
  if (!conversationId) return 0;
  const { raw, vectorAvailable, ftsAvailable } = ragDb();
  const rows = raw.prepare('SELECT rowid, id, chunk_text FROM rag_items WHERE conversation_id=?').all(conversationId) as Array<{ rowid: number; id: string; chunk_text: string }>;
  if (!rows.length) return 0;
  const tx = raw.transaction((items: typeof rows) => {
    for (const item of items) {
      if (vectorAvailable) raw.prepare('DELETE FROM vec_rag_items WHERE rowid=?').run(BigInt(item.rowid));
      if (ftsAvailable) raw.prepare('DELETE FROM fts_rag_items WHERE rowid=?').run(item.rowid);
      raw.prepare('DELETE FROM rag_items WHERE id=?').run(item.id);
    }
  });
  tx(rows);
  return rows.length;
}

export function hasMessageIndexed(userId: string, messageId: string) {
  const { raw } = ragDb();
  const row = raw.prepare('SELECT 1 FROM rag_items WHERE user_id=? AND message_id=? LIMIT 1').get(userId, messageId) as { 1?: number } | undefined;
  return !!row;
}

export function hasMessageEmbedded(userId: string, messageId: string, dimensions: number) {
  const { raw, vectorAvailable } = ragDb();
  if (!vectorAvailable) return false;
  const row = raw.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN r.embedded_at IS NOT NULL AND r.embedding_dim=? AND v.rowid IS NOT NULL THEN 1 ELSE 0 END) AS complete FROM rag_items r LEFT JOIN vec_rag_items v ON v.rowid=r.rowid WHERE r.user_id=? AND r.message_id=?`).get(dimensions, userId, messageId) as { total: number; complete: number | null };
  return row.total > 0 && row.complete === row.total;
}

export function insertChunk(chunk: ChunkInsert) {
  const { raw, vectorAvailable, ftsAvailable, dimensions } = ragDb();
  const insertItem = raw.prepare(`
    INSERT INTO rag_items (
      id, user_id, conversation_id, message_id, role, chunk_index, chunk_text, chunk_type, importance, created_at, embedded_at, embedding_dim, content_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id, content_hash) DO UPDATE SET message_id=excluded.message_id, role=excluded.role, chunk_index=excluded.chunk_index, created_at=excluded.created_at, importance=excluded.importance
    WHERE excluded.created_at > rag_items.created_at OR (excluded.created_at = rag_items.created_at AND (excluded.importance > rag_items.importance OR (excluded.importance = rag_items.importance AND excluded.role='user' AND rag_items.role<>'user')))
  `);
  const tx = raw.transaction((c: ChunkInsert) => {
    const hash = chunkContentHash(c.chunkText);
    const existing = raw.prepare('SELECT rowid FROM rag_items WHERE conversation_id=? AND content_hash=?').get(c.conversationId, hash) as { rowid: number } | undefined;
    const info = insertItem.run(
      c.id,
      c.userId,
      c.conversationId,
      c.messageId,
      c.role,
      c.chunkIndex,
      c.chunkText,
      c.chunkType || 'text',
      typeof c.importance === 'number' ? c.importance : 0.5,
      c.createdAt,
      null,
      null,
      hash
    );
    const rowid = existing ? Number(existing.rowid) : (info.changes === 0 ? null : Number(info.lastInsertRowid));
    if (rowid === null) return null;
    if (c.embedding && vectorAvailable) {
      try {
        const hasVector = raw.prepare('SELECT 1 FROM vec_rag_items WHERE rowid=?').get(BigInt(rowid));
        if (!hasVector) {
          raw.prepare('INSERT INTO vec_rag_items (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), vectorBuffer(c.embedding));
          raw.prepare('UPDATE rag_items SET embedded_at=?, embedding_dim=? WHERE rowid=?').run(now(), c.dimensions || dimensions, rowid);
        }
      } catch (error) {
        console.warn('[rag] vec insert failed, chunk stored without embedding:', error instanceof Error ? error.message : error);
      }
    }
    if (ftsAvailable) {
      const hasFts = raw.prepare('SELECT 1 FROM fts_rag_items WHERE rowid=?').get(rowid);
      if (!hasFts) raw.prepare('INSERT INTO fts_rag_items(rowid, chunk_text) VALUES (?, ?)').run(rowid, c.chunkText);
    }
    return rowid;
  });
  return tx(chunk);
}

function matchQuery(query: string) {
  const normalized = normalizeChunkText(query);
  const terms = new Set<string>();
  for (const run of normalized.match(/[\u3400-\u9fff]{3,}|[a-z0-9][a-z0-9._-]{2,}/giu) || []) {
    if (/^[\u3400-\u9fff]+$/u.test(run)) for (let i = 0; i <= run.length - 3 && terms.size < 12; i += 1) terms.add(run.slice(i, i + 3));
    else terms.add(run);
    if (terms.size >= 12) break;
  }
  return [...terms].map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

export function keywordCandidatesForQuery(query: string, overFetch: number, conversationId: string): KeywordCandidate[] {
  const database = ragDb();
  const { raw, ftsAvailable } = database;
  const match = matchQuery(query);
  if (!ftsAvailable || !match || !conversationId) return [];
  try {
    return raw.prepare(`SELECT r.rowid, bm25(fts_rag_items) AS rank, r.* FROM fts_rag_items JOIN rag_items r ON r.rowid=fts_rag_items.rowid WHERE fts_rag_items MATCH ? AND r.conversation_id=? ORDER BY rank ASC LIMIT ?`).all(match, conversationId, Math.min(15, overFetch)) as KeywordCandidate[];
  } catch (error) {
    database.ftsAvailable = false;
    console.warn('[rag] FTS query failed, continuing without keywords:', error instanceof Error ? error.message : error);
    return [];
  }
}

export function embeddingsForCandidates(rowids: number[]) {
  const { raw, vectorAvailable } = ragDb();
  const ids = [...new Set(rowids)];
  if (!vectorAvailable || !ids.length) return new Map<number, Float32Array>();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = raw.prepare(`SELECT rowid, embedding FROM vec_rag_items WHERE rowid IN (${placeholders})`).all(...ids) as Array<{ rowid: number; embedding: Buffer }>;
    return new Map(rows.map(row => [Number(row.rowid), new Float32Array(row.embedding.buffer, row.embedding.byteOffset, Math.floor(row.embedding.byteLength / 4))]));
  } catch (error) {
    console.warn('[rag] embedding lookup failed:', error instanceof Error ? error.message : error);
    return new Map<number, Float32Array>();
  }
}

export type VectorCandidatesOptions = {
  // When provided, restricts candidate lookup to chunks belonging to this
  // conversation. This is the new isolation boundary for retrieval.
  conversationId?: string;
};

export function vectorCandidatesForQuery(
  embedding: Float32Array,
  overFetch: number,
  options: VectorCandidatesOptions = {}
): RagCandidate[] {
  const { raw, vectorAvailable } = ragDb();
  if (!vectorAvailable) return [];
  let rows: Array<{ rowid: number; distance: number }>;
  try {
    const target = Math.max(1, overFetch);
    const total = Number((raw.prepare('SELECT COUNT(*) AS count FROM vec_rag_items').get() as { count: number }).count);
    const statement = raw.prepare(`SELECT rowid, distance FROM vec_rag_items WHERE embedding MATCH ? ORDER BY distance LIMIT ?`);
    let limit = Math.min(target, total);
    rows = [];
    while (limit > 0) {
      const fetched = statement.all(vectorBuffer(embedding), limit) as Array<{ rowid: number; distance: number }>;
      rows = fetched;
      if (!options.conversationId || fetched.length >= total) break;
      const ids = fetched.map(row => Number(row.rowid));
      if (!ids.length) break;
      const scoped = raw.prepare(`SELECT COUNT(*) AS count FROM rag_items WHERE conversation_id=? AND rowid IN (${ids.map(() => '?').join(',')})`).get(options.conversationId, ...ids) as { count: number };
      if (scoped.count >= target || limit >= total) break;
      limit = Math.min(total, Math.max(limit + 1, limit * 2));
    }
  } catch (error) {
    console.warn('[rag] vector search failed:', error instanceof Error ? error.message : error);
    return [];
  }
  if (!rows.length) return [];
  const normalizedRows = rows.map(r => ({ rowid: Number(r.rowid), distance: r.distance }));
  const rowids = normalizedRows.map(r => r.rowid);
  const placeholders = rowids.map(() => '?').join(',');
  // vec0 has no conversation metadata: candidates are globally ordered first,
  // then hydrated and filtered below.
  const filterParams: unknown[] = [];
  let filterClause = '';
  if (options.conversationId) {
    filterClause = ' AND conversation_id=?';
    filterParams.push(options.conversationId);
  }
  const items = raw.prepare(`SELECT rowid, * FROM rag_items WHERE rowid IN (${placeholders})${filterClause}`).all(...rowids, ...filterParams) as RagItemWithRowid[];
  const byRowid = new Map<number, RagItemRow>();
  for (const item of items) byRowid.set(item.rowid, item);
  const result: RagCandidate[] = [];
  for (const r of normalizedRows) {
    const item = byRowid.get(r.rowid);
    if (item) result.push({ rowid: r.rowid, distance: r.distance, item });
  }
  return result;
}

export function recordChunkHits(rowids: number[]) {
  const uniqueRowids = [...new Set(rowids.map(Number).filter(Number.isFinite))];
  if (!uniqueRowids.length) return 0;
  const { raw } = ragDb();
  const timestamp = now();
  const update = raw.prepare('UPDATE rag_items SET hit_count=hit_count + 1, last_hit_at=? WHERE rowid=?');
  const tx = raw.transaction((ids: number[]) => {
    for (const rowid of ids) update.run(timestamp, rowid);
  });
  tx(uniqueRowids);
  return uniqueRowids.length;
}

export function recordChunksInjected(rowids: number[]) {
  const uniqueRowids = [...new Set(rowids.map(Number).filter(Number.isFinite))];
  if (!uniqueRowids.length) return 0;
  const { raw } = ragDb();
  const timestamp = now();
  const update = raw.prepare('UPDATE rag_items SET last_injected_at=? WHERE rowid=?');
  const tx = raw.transaction((ids: number[]) => {
    for (const rowid of ids) update.run(timestamp, rowid);
  });
  tx(uniqueRowids);
  return uniqueRowids.length;
}

export function listAllItemsByMessage(userId: string, messageId: string) {
  const { raw } = ragDb();
  return raw.prepare('SELECT rowid, * FROM rag_items WHERE user_id=? AND message_id=? ORDER BY chunk_index ASC').all(userId, messageId) as RagItemWithRowid[];
}

export function listAllItems() {
  const { raw } = ragDb();
  return raw.prepare('SELECT rowid, * FROM rag_items').all() as RagItemWithRowid[];
}

export function listDistinctIndexedMessageIds() {
  const { raw } = ragDb();
  return raw.prepare('SELECT DISTINCT user_id, message_id FROM rag_items').all() as Array<{ user_id: string; message_id: string }>;
}
