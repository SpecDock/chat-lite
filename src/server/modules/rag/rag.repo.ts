import { ragDb } from './rag-db.js';
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

function vectorBuffer(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deleteMessageChunks(userId: string, messageId: string) {
  const { raw, vectorAvailable } = ragDb();
  const rows = raw.prepare('SELECT rowid, id FROM rag_items WHERE user_id=? AND message_id=?').all(userId, messageId) as Array<{ rowid: number; id: string }>;
  if (!rows.length) return 0;
  const tx = raw.transaction((items: Array<{ rowid: number; id: string }>) => {
    for (const item of items) {
      raw.prepare('DELETE FROM rag_items WHERE id=?').run(item.id);
      if (vectorAvailable) {
        try {
          raw.prepare('DELETE FROM vec_rag_items WHERE rowid=?').run(BigInt(item.rowid));
        } catch (error) {
          console.warn('[rag] vec delete failed:', error instanceof Error ? error.message : error);
        }
      }
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
  const { raw, vectorAvailable } = ragDb();
  const rows = raw.prepare('SELECT rowid, id FROM rag_items WHERE conversation_id=?').all(conversationId) as Array<{ rowid: number; id: string }>;
  if (!rows.length) return 0;
  const tx = raw.transaction((items: Array<{ rowid: number; id: string }>) => {
    for (const item of items) {
      raw.prepare('DELETE FROM rag_items WHERE id=?').run(item.id);
      if (vectorAvailable) {
        try {
          raw.prepare('DELETE FROM vec_rag_items WHERE rowid=?').run(BigInt(item.rowid));
        } catch (error) {
          console.warn('[rag] vec delete failed:', error instanceof Error ? error.message : error);
        }
      }
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
  const { raw } = ragDb();
  const row = raw.prepare('SELECT 1 FROM rag_items WHERE user_id=? AND message_id=? AND embedded_at IS NOT NULL AND embedding_dim=? LIMIT 1').get(userId, messageId, dimensions) as { 1?: number } | undefined;
  return !!row;
}

export function insertChunk(chunk: ChunkInsert) {
  const { raw, vectorAvailable, dimensions } = ragDb();
  const insertItem = raw.prepare(`
    INSERT INTO rag_items (
      id, user_id, conversation_id, message_id, role, chunk_index, chunk_text, chunk_type, importance, created_at, embedded_at, embedding_dim
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const tx = raw.transaction((c: ChunkInsert) => {
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
      c.embedding ? now() : null,
      c.embedding ? (c.dimensions || dimensions) : null
    );
    const rowid = Number(info.lastInsertRowid);
    if (c.embedding && vectorAvailable) {
      try {
        raw.prepare('INSERT INTO vec_rag_items (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), vectorBuffer(c.embedding));
      } catch (error) {
        console.warn('[rag] vec insert failed, chunk stored without embedding:', error instanceof Error ? error.message : error);
      }
    }
    return rowid;
  });
  return tx(chunk);
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
    rows = raw.prepare(`
      SELECT rowid, distance
      FROM vec_rag_items
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vectorBuffer(embedding), overFetch) as Array<{ rowid: number; distance: number }>;
  } catch (error) {
    console.warn('[rag] vector search failed:', error instanceof Error ? error.message : error);
    return [];
  }
  if (!rows.length) return [];
  const normalizedRows = rows.map(r => ({ rowid: Number(r.rowid), distance: r.distance }));
  const rowids = normalizedRows.map(r => r.rowid);
  const placeholders = rowids.map(() => '?').join(',');
  // Push the conversation filter into SQL when provided so we never hydrate
  // rows from other conversations. Backwards-compatible: without options, the
  // previous behaviour (no metadata filter) is preserved.
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
