import { nanoid } from 'nanoid';
import { cleanForIndexing, splitIndexedChunks, type RagChunk } from './chunker.js';
import { embedText, embeddingConfigured } from '../../infrastructure/rag/embedding.client.js';
import { ragConfig, ragReadActive } from './rag.config.js';
import { ragDb } from '../../infrastructure/rag/rag-db.js';
import {
  deleteMessageChunks,
  hasMessageEmbedded,
  hasMessageIndexed,
  insertChunk,
  listDistinctIndexedMessageIds,
  recordChunkHits,
  recordChunksInjected,
  embeddingsForCandidates,
  keywordCandidatesForQuery,
  type RagCandidate,
  vectorCandidatesForQuery
} from '../../infrastructure/rag/rag.repo.js';
import { listMessages } from '../../infrastructure/chat/chat.repo.js';
import { answerHistoryLimit } from '../../domain/chat/history-limits.js';
import { isModelVisibleMessage } from '../../domain/chat/message-visibility.js';

export type RagIndexInput = {
  userId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'streaming' | 'completed' | 'interrupted' | 'error';
  createdAt?: string;
};

export type RagHit = {
  messageId: string;
  conversationId: string;
  role: string;
  text: string;
  importance: number;
  score: number;
};

type RankedCandidate = RagCandidate & { score: number };

export function ragWriteEnabled() {
  return ragConfig().writeEnabled;
}

export function ragShadowEnabled() {
  return ragConfig().shadowEnabled;
}

export function ragReadEnabled() {
  return ragConfig().readEnabled;
}

export function ragAvailable(): boolean {
  return ragConfig().writeEnabled || ragReadActive();
}

function chunkId(messageId: string, index: number) {
  return `rag_${messageId}_${index}_${nanoid(8)}`;
}

function buildChunksForMessage(input: RagIndexInput): RagChunk[] {
  const cfg = ragConfig();
  const cleaned = cleanForIndexing(input.content, cfg.contentMaxChars);
  if (!cleaned || cleaned.length < 8) return [];
  return splitIndexedChunks(cleaned);
}

function recallText(item: { chunk_text: string; parent_text?: string | null }) {
  const parent = item.parent_text?.trim();
  return parent || item.chunk_text;
}

async function indexOne(input: RagIndexInput) {
  if (!ragWriteEnabled()) return;
  if (!input.messageId || !input.userId || !input.conversationId) return;
  if (input.role !== 'user' && input.role !== 'assistant') return;
  if (!isModelVisibleMessage({ ...input, status: input.status || 'completed' })) {
    deleteMessageChunks(input.userId, input.messageId);
    return;
  }
  const cfg = ragConfig();
  const cleaned = cleanForIndexing(input.content, cfg.contentMaxChars);
  if (!cleaned || cleaned.length < 8) {
    console.info(`[rag] skipped (cleaned empty): ${input.messageId}`);
    return;
  }
  const chunks = buildChunksForMessage(input);
  if (!chunks.length) {
    console.info(`[rag] skipped (no chunks): ${input.messageId}`);
    return;
  }
  const useEmbeddings = embeddingConfigured() && ragDb().vectorAvailable;
  const createdAt = input.createdAt || new Date().toISOString();
  let embeddedCount = 0;
  const prepared: Array<{ chunk: RagChunk; embedding: Float32Array | null }> = [];
  let embeddingFailed = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let embedding: Float32Array | null = null;
    if (useEmbeddings) {
      try {
        const result = await embedText(chunk.text);
        if (result) {
          embedding = result.vector;
          embeddedCount += 1;
        } else {
          embeddingFailed = true;
        }
      } catch (error) {
        embeddingFailed = true;
        console.warn('[rag] embedding threw while indexing:', error instanceof Error ? error.message : error);
      }
    }
    prepared.push({ chunk, embedding });
  }
  // Do not discard a known-good index until all remote embedding work succeeded.
  if (useEmbeddings && embeddingFailed && hasMessageIndexed(input.userId, input.messageId)) {
    console.warn(`[rag] embedding incomplete; preserving existing index for ${input.messageId}`);
    return;
  }
  if (useEmbeddings && embeddingFailed) console.warn(`[rag] embedding incomplete; storing keyword-only chunks for new message ${input.messageId}`);
  deleteMessageChunks(input.userId, input.messageId);
  for (let i = 0; i < prepared.length; i += 1) {
    const { chunk, embedding } = prepared[i];
    insertChunk({
      id: chunkId(input.messageId, i),
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      role: input.role,
      chunkIndex: i,
      chunkText: chunk.text,
      parentText: chunk.parentText,
      chunkType: chunk.type || 'text',
      importance: typeof chunk.importance === 'number' ? chunk.importance : 0.5,
      createdAt,
      embedding,
      dimensions: cfg.embedding.dimensions
    });
  }
  console.info(`[rag] indexed ${input.messageId} chunks=${chunks.length} embedded=${embeddedCount} role=${input.role}`);
}

export function scheduleIndexMessage(input: RagIndexInput) {
  if (!ragWriteEnabled()) return;
  // fire-and-forget; never block the request
  void (async () => {
    try {
      await indexOne(input);
    } catch (error) {
      console.warn('[rag] index failed:', error instanceof Error ? error.message : error);
    }
  })();
}

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function jaccard(a: string, b: string) {
  const tokens = (text: string) => {
    const normalized = text.toLowerCase().replace(/\s+/gu, ' ').trim();
    const values = new Set<string>();
    for (const word of normalized.match(/[a-z0-9][a-z0-9._-]*/giu) || []) values.add(`w:${word}`);
    const compact = normalized.replace(/\s+/gu, '');
    for (let i = 0; i + 2 < compact.length; i += 1) values.add(`t:${compact.slice(i, i + 3)}`);
    return values;
  };
  const left = tokens(a);
  const right = tokens(b);
  let shared = 0; for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared || 1);
}

function preferred(a: RankedCandidate, b: RankedCandidate) {
  if (a.item.created_at !== b.item.created_at) return a.item.created_at > b.item.created_at ? a : b;
  if (a.item.importance !== b.item.importance) return a.item.importance > b.item.importance ? a : b;
  return a.item.role === 'user' ? a : b;
}

// userId is retained for log attribution and shadow-mode tracing only; it is
// no longer used as an isolation boundary. conversationId is now the sole
// retrieval scope.
export async function retrieveForUser(userId: string, query: string, historyCount: number, topK = ragConfig().topK, conversationId?: string, signal?: AbortSignal): Promise<RagHit[]> {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  if (!ragReadActive()) return [];
  const cfg = ragConfig();
  if (!conversationId || !query || !query.trim()) return [];
  const answerLimit = historyCount > 0 ? historyCount : answerHistoryLimit();
  const effectiveTopK = Math.max(0, Math.min(topK, cfg.topK));
  if (effectiveTopK <= 0) return [];
  const overFetch = 15;
  let embedding: Float32Array | null = null;
  if (ragDb().vectorAvailable && embeddingConfigured()) {
    try {
      const result = await embedText(query, signal);
      if (result) embedding = result.vector;
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
      console.warn('[rag] query embedding failed, continuing keyword-only', {
        name: error instanceof Error ? error.name : undefined,
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      });
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  let candidates: RagCandidate[] = [];
  if (embedding) {
    // vec0 candidates are globally ordered; repository overfetches until the
    // conversation-scoped candidate target is met.
    candidates = vectorCandidatesForQuery(embedding, overFetch, { conversationId });
  }
  // Distance threshold: drop low-similarity chunks before they consume TopK
  // budget or count as hits. 0 disables the filter.
  const maxDistance = cfg.maxDistance > 0 ? cfg.maxDistance : Number.POSITIVE_INFINITY;
  const beforeFilter = candidates.length;
  candidates = candidates.filter(c => c.distance <= maxDistance);
  if (beforeFilter !== candidates.length && cfg.shadowEnabled) {
    console.info(`[rag] filtered by maxDistance=${cfg.maxDistance}: dropped=${beforeFilter - candidates.length} kept=${candidates.length}`);
  }
  const keyword = keywordCandidatesForQuery(query, overFetch, conversationId);
  const union = new Map<number, { candidate: RagCandidate; vectorRank?: number; keywordRank?: number }>();
  candidates.forEach((candidate, index) => union.set(candidate.rowid, { candidate, vectorRank: index + 1 }));
  keyword.forEach((candidate, index) => {
    const current = union.get(candidate.rowid);
    if (current) current.keywordRank = index + 1;
    else union.set(candidate.rowid, { candidate: { rowid: candidate.rowid, distance: 0, item: candidate.item }, keywordRank: index + 1 });
  });
  const maximum = 1 / 61;
  const ranked: RankedCandidate[] = [...union.values()].map(({ candidate, vectorRank, keywordRank }) => ({
    ...candidate,
    score: ((vectorRank ? 0.7 / (60 + vectorRank) : 0) + (keywordRank ? 0.3 / (60 + keywordRank) : 0)) / maximum
  })).sort((a, b) => b.score - a.score);
  const embeddings = embeddingsForCandidates(ranked.map(candidate => candidate.rowid));
  const parent = ranked.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  for (let i = 0; i < ranked.length; i += 1) for (let j = 0; j < i; j += 1) {
    const a = embeddings.get(ranked[i].rowid); const b = embeddings.get(ranked[j].rowid);
    if (a && b && a.length === b.length && cosine(a, b) >= 0.95 && jaccard(ranked[i].item.chunk_text, ranked[j].item.chunk_text) >= 0.85) parent[find(i)] = find(j);
  }
  const groups = new Map<number, RankedCandidate[]>();
  ranked.forEach((candidate, index) => { const group = find(index); groups.set(group, [...(groups.get(group) || []), candidate]); });
  const deduped = [...groups.values()].map(group => {
    const representative = group.reduce(preferred);
    representative.score = Math.max(...group.map(candidate => candidate.score));
    return representative;
  });
  deduped.sort((a, b) => b.score - a.score);
  const seenRecall = new Set<string>();
  const recalled = deduped.filter(candidate => {
    const text = recallText(candidate.item).replace(/\s+/g, ' ').trim();
    if (seenRecall.has(text)) return false;
    seenRecall.add(text);
    return true;
  });
  const filtered = recalled.slice(0, effectiveTopK);
  recordChunkHits(filtered.map(c => c.rowid));
  if (cfg.readEnabled) recordChunksInjected(filtered.map(c => c.rowid));
  const hits: RagHit[] = filtered.map(c => ({
    messageId: c.item.message_id,
    conversationId: c.item.conversation_id,
    role: c.item.role,
    text: recallText(c.item),
    importance: c.item.importance,
    score: c.score
  }));
  if (cfg.shadowEnabled) {
    const preview = hits.map((hit, idx) => `${idx + 1}:${hit.role}:${hit.score.toFixed(2)}:${hit.text.slice(0, 120)}`).join(' | ');
    console.info(`[rag] shadow retrieve user=${userId} conversation=${conversationId} vector=${candidates.length} keyword=${keyword.length} union=${union.size} dedup=${deduped.length} final=${hits.length} topK=${effectiveTopK} answerLimit=${answerLimit}${preview ? ` ${preview}` : ''}`);
  }
  return hits;
}

export function formatHitsForPrompt(hits: RagHit[]): string {
  if (!hits.length) return '';
  const cfg = ragConfig();
  const limit = cfg.contentMaxChars > 0 ? cfg.contentMaxChars : 1200;
  const blocks = hits.map((hit, idx) => {
    const text = hit.text.length > limit ? `${hit.text.slice(0, limit)}…` : hit.text;
    const roleLabel = hit.role === 'user' ? '用户' : '助手';
    return `[${idx + 1}] (${roleLabel}, 相关度=${hit.score.toFixed(2)}) ${text}`;
  });
  return `可能相关的历史记忆（仅在相关时使用）：\n${blocks.join('\n')}`;
}

export type BackfillSummary = {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: number;
};

export type BackfillCandidate = {
  id: string;
  user_id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'error';
  created_at: string;
};

export async function purgeNonVisibleRagChunks() {
  const { db } = await import('../../infrastructure/db/db.js');
  const rows = db.prepare("SELECT id,user_id,role,content,status FROM messages WHERE role='assistant'").all() as Array<Pick<BackfillCandidate, 'id' | 'user_id' | 'role' | 'content' | 'status'>>;
  let removed = 0;
  for (const candidate of rows) {
    if (!isModelVisibleMessage(candidate)) removed += deleteMessageChunks(candidate.user_id, candidate.id);
  }
  return removed;
}

export async function purgeOrphanedRagChunks() {
  const { db } = await import('../../infrastructure/db/db.js');
  const indexedMessages = listDistinctIndexedMessageIds();
  const messageExists = db.prepare('SELECT 1 FROM messages WHERE id=? AND user_id=? LIMIT 1');
  let removed = 0;
  for (const candidate of indexedMessages) {
    if (!messageExists.get(candidate.message_id, candidate.user_id)) {
      removed += deleteMessageChunks(candidate.user_id, candidate.message_id);
    }
  }
  return removed;
}

async function backfillBatch(candidates: BackfillCandidate[], summary: BackfillSummary, delayMs: number) {
  const cfg = ragConfig();
  const shouldRequireEmbeddings = embeddingConfigured() && ragDb().vectorAvailable;
  for (const candidate of candidates) {
    summary.scanned += 1;
    if (!isModelVisibleMessage(candidate)) {
      deleteMessageChunks(candidate.user_id, candidate.id);
      summary.skipped += 1;
      continue;
    }
    const alreadyDone = shouldRequireEmbeddings
      ? hasMessageEmbedded(candidate.user_id, candidate.id, cfg.embedding.dimensions)
      : hasMessageIndexed(candidate.user_id, candidate.id);
    if (alreadyDone) {
      summary.skipped += 1;
      continue;
    }
    try {
      await indexOne({
        userId: candidate.user_id,
        conversationId: candidate.conversation_id,
        messageId: candidate.id,
        role: candidate.role,
        content: candidate.content,
        status: candidate.status,
        createdAt: candidate.created_at
      });
      summary.indexed += 1;
    } catch (error) {
      summary.errors += 1;
      console.warn('[rag] backfill index failed:', error instanceof Error ? error.message : error);
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

export async function runBackfill(options: { userIds?: string[]; limit?: number; delayMs?: number; batchSize?: number } = {}): Promise<BackfillSummary> {
  const cfg = ragConfig();
  const summary: BackfillSummary = { scanned: 0, indexed: 0, skipped: 0, errors: 0 };
  const batchSize = options.batchSize ?? cfg.backfill.batchSize;
  const delayMs = options.delayMs ?? cfg.backfill.delayMs;
  const { db } = await import('../../infrastructure/db/db.js');
  await purgeNonVisibleRagChunks();
  const params: unknown[] = [];
  // Skip messages whose parent conversation no longer exists (e.g. deleted
  // while the backfill was queued). Keeps historical indexing consistent with
  // the new conversation-scoped isolation model.
  let where = "WHERE role IN ('user','assistant') AND status IN ('completed','interrupted') AND EXISTS (SELECT 1 FROM conversations WHERE conversations.id = messages.conversation_id)";
  if (options.userIds?.length) {
    const placeholders = options.userIds.map(() => '?').join(',');
    where += ` AND user_id IN (${placeholders})`;
    params.push(...options.userIds);
  }
  const sql = `SELECT id, user_id, conversation_id, role, content, status, created_at FROM messages ${where} ORDER BY created_at ASC`;
  const rows = db.prepare(sql).all(...params) as BackfillCandidate[];
  const slice = options.limit && options.limit > 0 ? rows.slice(0, options.limit) : rows;
  for (let i = 0; i < slice.length; i += batchSize) {
    const batch = slice.slice(i, i + batchSize);
    await backfillBatch(batch, summary, delayMs);
  }
  return summary;
}

export function listMessagesForUser(userId: string, conversationId: string) {
  return listMessages(conversationId, userId);
}

export function ragStatus() {
  const cfg = ragConfig();
  return {
    writeEnabled: cfg.writeEnabled,
    readEnabled: cfg.readEnabled,
    shadowEnabled: cfg.shadowEnabled,
    topK: cfg.topK,
    dimensions: cfg.embedding.dimensions,
    chunkEnabled: cfg.chunkEnabled,
    vectorAvailable: ragDb().vectorAvailable,
    embeddingConfigured: embeddingConfigured(),
    chunkerConfigured: !!cfg.chunker.apiKey && !!cfg.chunker.model
  };
}
