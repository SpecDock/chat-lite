import { nanoid } from 'nanoid';
import { cleanForIndexing, semanticChunk, simpleChunk, type RagChunk } from './chunker.js';
import { embedText, embeddingConfigured } from './embedding.client.js';
import { ragConfig, ragReadActive } from './rag.config.js';
import { ragDb } from './rag-db.js';
import {
  deleteMessageChunks,
  hasMessageEmbedded,
  hasMessageIndexed,
  insertChunk,
  recordChunkHits,
  recordChunksInjected,
  type RagCandidate,
  vectorCandidatesForQuery
} from './rag.repo.js';
import { listMessages } from '../chat/chat.repo.js';
import { answerHistoryLimit } from '../chat/history-limits.js';

export type RagIndexInput = {
  userId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
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

async function buildChunksForMessage(input: RagIndexInput): Promise<RagChunk[]> {
  const cfg = ragConfig();
  const cleaned = cleanForIndexing(input.content, cfg.contentMaxChars);
  if (!cleaned || cleaned.length < 8) return [];
  if (!cfg.chunkEnabled) return simpleChunk(cleaned, cfg.chunkMaxChars);
  try {
    const chunks = await semanticChunk(cleaned, cfg.chunkMaxChars);
    if (chunks.length) return chunks;
  } catch (error) {
    console.warn('[rag] semantic chunker threw, fallback:', error instanceof Error ? error.message : error);
  }
  return simpleChunk(cleaned, cfg.chunkMaxChars);
}

async function indexOne(input: RagIndexInput) {
  if (!ragWriteEnabled()) return;
  if (!input.messageId || !input.userId || !input.conversationId) return;
  if (input.role !== 'user' && input.role !== 'assistant') return;
  // Replace existing chunks for this message (idempotent re-indexing).
  deleteMessageChunks(input.userId, input.messageId);
  const cfg = ragConfig();
  const cleaned = cleanForIndexing(input.content, cfg.contentMaxChars);
  if (!cleaned || cleaned.length < 8) {
    console.info(`[rag] skipped (cleaned empty): ${input.messageId}`);
    return;
  }
  const chunks = await buildChunksForMessage(input);
  if (!chunks.length) {
    console.info(`[rag] skipped (no chunks): ${input.messageId}`);
    return;
  }
  const useEmbeddings = embeddingConfigured() && ragDb().vectorAvailable;
  const createdAt = input.createdAt || new Date().toISOString();
  let embeddedCount = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let embedding: Float32Array | null = null;
    if (useEmbeddings) {
      const result = await embedText(chunk.text);
      if (result) {
        embedding = result.vector;
        embeddedCount += 1;
      }
    }
    insertChunk({
      id: chunkId(input.messageId, i),
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      role: input.role,
      chunkIndex: i,
      chunkText: chunk.text,
      chunkType: chunk.type || 'text',
      importance: typeof chunk.importance === 'number' ? chunk.importance : 0.5,
      createdAt,
      embedding
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

function rankCandidate(candidate: RagCandidate, currentConversationId: string | undefined, boost: number): RankedCandidate {
  const baseScore = 1 / (1 + candidate.distance);
  const conversationBoost = currentConversationId && candidate.item.conversation_id === currentConversationId ? boost : 0;
  return { ...candidate, score: baseScore + conversationBoost };
}

export async function retrieveForUser(userId: string, query: string, historyCount: number, topK = ragConfig().topK, currentConversationId?: string): Promise<RagHit[]> {
  if (!ragReadActive()) return [];
  const cfg = ragConfig();
  if (!userId || !query || !query.trim()) return [];
  const answerLimit = historyCount > 0 ? historyCount : answerHistoryLimit();
  const effectiveTopK = Math.max(0, Math.min(topK, cfg.topK));
  if (effectiveTopK <= 0) return [];
  const overFetch = Math.max(effectiveTopK * 5, 8);
  let embedding: Float32Array | null = null;
  if (ragDb().vectorAvailable && embeddingConfigured()) {
    const result = await embedText(query);
    if (result) embedding = result.vector;
  }
  let candidates: RagCandidate[] = [];
  if (embedding) {
    candidates = vectorCandidatesForQuery(embedding, overFetch);
  } else {
    console.warn('[rag] vector search unavailable, skipping retrieval');
    return [];
  }
  const ranked = candidates
    .filter(c => c.item.user_id === userId)
    .map(c => rankCandidate(c, currentConversationId, cfg.currentConversationBoost))
    .sort((a, b) => b.score - a.score);
  recordChunkHits(ranked.map(c => c.rowid));
  const filtered = ranked.slice(0, effectiveTopK);
  if (cfg.readEnabled) recordChunksInjected(filtered.map(c => c.rowid));
  const hits: RagHit[] = filtered.map(c => ({
    messageId: c.item.message_id,
    conversationId: c.item.conversation_id,
    role: c.item.role,
    text: c.item.chunk_text,
    importance: c.item.importance,
    score: c.score
  }));
  if (cfg.shadowEnabled && !cfg.readEnabled) {
    const preview = hits.map((hit, idx) => `${idx + 1}:${hit.role}:${hit.score.toFixed(2)}:${hit.text.slice(0, 120)}`).join(' | ');
    console.info(`[rag] shadow retrieve user=${userId} topK=${effectiveTopK} hits=${hits.length} answerLimit=${answerLimit}${preview ? ` ${preview}` : ''}`);
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
  created_at: string;
};

async function backfillBatch(candidates: BackfillCandidate[], summary: BackfillSummary, delayMs: number) {
  const cfg = ragConfig();
  const shouldRequireEmbeddings = embeddingConfigured() && ragDb().vectorAvailable;
  for (const candidate of candidates) {
    summary.scanned += 1;
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
  const { db } = await import('../../core/db.js');
  const params: unknown[] = [];
  let where = "WHERE role IN ('user','assistant') AND status IN ('completed','interrupted','error')";
  if (options.userIds?.length) {
    const placeholders = options.userIds.map(() => '?').join(',');
    where += ` AND user_id IN (${placeholders})`;
    params.push(...options.userIds);
  }
  const sql = `SELECT id, user_id, conversation_id, role, content, created_at FROM messages ${where} ORDER BY created_at ASC`;
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
