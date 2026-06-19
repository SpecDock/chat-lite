import { ragConfig, ragReadActive } from './rag.config.js';
import { ragDb, closeRagDb } from './rag-db.js';
import { retrieveForUser, formatHitsForPrompt, scheduleIndexMessage, ragAvailable, ragStatus, type RagHit } from './rag.service.js';

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
  } catch (error) {
    console.warn('[rag] initialization failed:', error instanceof Error ? error.message : error);
  }
}

export function shutdownRag() {
  closeRagDb();
}

export async function getRagContext(userId: string, query: string, historyCount: number, topK?: number, currentConversationId?: string): Promise<string> {
  const hits = await retrieveForUser(userId, query, historyCount, topK, currentConversationId);
  return ragConfig().readEnabled ? formatHitsForPrompt(hits) : '';
}

export function indexChatMessage(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}) {
  if (!ragAvailable()) return;
  ensureRagInitialized();
  scheduleIndexMessage(input);
}

export { ragStatus };
export type { RagHit };
