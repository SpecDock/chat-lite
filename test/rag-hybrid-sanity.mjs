import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'chat-lite-rag-sanity-'));
process.env.RAG_DATABASE_PATH = join(directory, 'rag.db');
process.env.EMBEDDING_DIMENSIONS = '4';

const { closeRagDb, ragDb } = await import('../src/server/modules/rag/rag-db.ts');
const { deleteMessageChunks, insertChunk, keywordCandidatesForQuery, listAllItems } = await import('../src/server/modules/rag/rag.repo.ts');
const { jaccard } = await import('../src/server/modules/rag/rag.service.ts');

try {
  const text = '中文检索 gpt-image-2 错误码 E_IMAGE_429 的处理说明，包含足够长度用于 sanity 验证。';
  const add = (id, conversationId, messageId, role, createdAt, importance, embedding = null) => insertChunk({
    id, userId: 'user-1', conversationId, messageId, role, chunkIndex: 0, chunkText: text,
    createdAt, importance, embedding, dimensions: 4
  });
  add('assistant-old', 'conversation-a', 'message-old', 'assistant', '2025-01-01T00:00:00.000Z', 0.2);
  add('assistant-important', 'conversation-a', 'message-important', 'assistant', '2025-01-01T00:00:00.000Z', 0.8);
  let rows = listAllItems();
  assert.equal(rows[0].importance, 0.8, 'higher importance must update the canonical duplicate');
  add('user-keeper', 'conversation-a', 'message-keeper', 'user', '2025-01-01T00:00:00.000Z', 0.8, new Float32Array([1, 0, 0, 0]));
  rows = listAllItems();
  assert.equal(rows[0].role, 'user', 'equal-date/equal-importance user must win');
  if (ragDb().vectorAvailable) {
    assert.ok(ragDb().raw.prepare('SELECT 1 FROM vec_rag_items WHERE rowid=?').get(rows[0].rowid), 'duplicate with an embedding must repair the canonical vec row');
    assert.equal(rows[0].embedding_dim, 4);
  }
  add('user-new', 'conversation-a', 'message-new', 'user', '2025-01-02T00:00:00.000Z', 0.9);
  rows = listAllItems();
  assert.equal(rows.length, 1, 'exact duplicates in one conversation must collapse');
  assert.equal(rows[0].message_id, 'message-new');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].importance, 0.9);
  add('other-conversation', 'conversation-b', 'message-other', 'assistant', '2025-01-01T00:00:00.000Z', 0.2);
  assert.equal(listAllItems().length, 2, 'identical text in distinct conversations must remain separate');
  for (const query of ['中文检索', 'gpt-image-2', 'E_IMAGE_429']) {
    assert.ok(keywordCandidatesForQuery(query, 15, 'conversation-a').length > 0, `FTS must find ${query}`);
  }
  const db = ragDb();
  assert.ok(db.ftsAvailable, 'sanity requires FTS5');
  const rowid = listAllItems().find(row => row.conversation_id === 'conversation-a').rowid;
  db.raw.prepare('DELETE FROM fts_rag_items WHERE rowid=?').run(rowid);
  assert.equal(keywordCandidatesForQuery('gpt-image-2', 15, 'conversation-a').length, 0, 'contentless FTS DELETE must work');
  insertChunk({ id: 'repair-fts', userId: 'user-1', conversationId: 'conversation-a', messageId: 'message-repair', role: 'user', chunkIndex: 0, chunkText: text, createdAt: '2025-01-03T00:00:00.000Z', importance: 1 });
  assert.ok(keywordCandidatesForQuery('gpt-image-2', 15, 'conversation-a').length > 0, 'duplicate insert must repair missing FTS row');
  assert.equal(deleteMessageChunks('user-1', 'message-repair'), 1);
  assert.equal(keywordCandidatesForQuery('gpt-image-2', 15, 'conversation-a').length, 0, 'message deletion must remove FTS row');
  assert.ok(jaccard('alpha beta', 'alphabet a') < 0.85, 'unrelated token forms must not be deduplicated');
  console.info('rag hybrid sanity passed');
} finally {
  closeRagDb();
  await rm(directory, { recursive: true, force: true });
}
