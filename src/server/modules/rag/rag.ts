import { ragConfig, ragReadActive } from './rag.config.js';
import { ragDb, closeRagDb } from './rag-db.js';
import { retrieveForUser, formatHitsForPrompt, scheduleIndexMessage, purgeNonVisibleRagChunks, purgeOrphanedRagChunks, ragAvailable, ragStatus, type RagHit } from './rag.service.js';
import { deleteMessageChunks } from './rag.repo.js';
import { isModelVisibleMessage } from '../chat/message-visibility.js';

let warmupTried = false;

export function ensureRagInitialized() {
  if (warmupTried) return;
  warmupTried = true;
  try {
    const cfg = ragConfig();
    const available = cfg.writeEnabled || ragReadActive();
    if (!available) return;
    const db = ragDb();
    console.info(`[rag] initialized: write=${cfg.writeEnabled} read=${cfg.readEnabled} shadow=${cfg.shadowEnabled} vector=${db.vectorAvailable} dim=${db.dimensions} path=${cfg.databasePath}`);
    void (async () => {
      const orphaned = await purgeOrphanedRagChunks();
      const nonVisible = await purgeNonVisibleRagChunks();
      if (orphaned > 0) console.info(`[rag] purged ${orphaned} orphaned chunks`);
      if (nonVisible > 0) console.info(`[rag] purged ${nonVisible} non-visible chunks`);
    })().catch(error => console.warn('[rag] startup chunk cleanup failed:', error instanceof Error ? error.message : error));
  } catch (error) {
    console.warn('[rag] initialization failed:', error instanceof Error ? error.message : error);
  }
}

export function shutdownRag() {
  closeRagDb();
}

export async function getRagContext(userId: string, query: string, historyCount: number, topK?: number, currentConversationId?: string, signal?: AbortSignal): Promise<string> {
  const hits = await retrieveForUser(userId, query, historyCount, topK, currentConversationId, signal);
  return ragConfig().readEnabled ? formatHitsForPrompt(hits) : '';
}

export function indexChatMessage(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'streaming' | 'completed' | 'interrupted' | 'error';
  createdAt?: string;
}) {
  if (!ragAvailable()) return;
  const status = input.status || 'completed';
  if (!isModelVisibleMessage({ ...input, status })) {
    deleteMessageChunks(input.userId, input.messageId);
    return;
  }
  ensureRagInitialized();
  scheduleIndexMessage({ ...input, status });
}

export { ragStatus };
export type { RagHit };
