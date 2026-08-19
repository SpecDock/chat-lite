import type { MessageDTO } from '../../../shared/types.js';
import {
  CONVERSATION_CACHE_IDLE_MINUTES,
  CONVERSATION_CONTEXT_COST_RATIO,
  CONVERSATION_SUMMARY_MAX_TOKENS,
  MODEL_CACHED_INPUT_PRICE_PER_MILLION,
  MODEL_INPUT_PRICE_PER_MILLION,
} from './conversation-context.config.js';
import {
  getContextState,
  getPreviousUserMessageCreatedAt,
  listConversationMessagesAfterCursor,
  upsertContextState,
  type ContextMessage,
} from './conversation-context.repo.js';
import {
  estimateConversationMessagesTokenCount,
  estimateConversationTokenCount,
  summarizeConversationContext,
} from './conversation-summary.service.js';
import { answerHistoryLimit } from './history-limits.js';
import { isModelVisibleMessage } from './message-visibility.js';

export type PrepareConversationContextInput = {
  userId: string;
  conversationId: string;
  currentMessageId: string;
  requestAt: string;
};

export type PreparedConversationContext = {
  summaryText: string;
  history: MessageDTO[];
  contextThinkLog?: string;
};

function toMessageDTO(message: ContextMessage, conversationId: string): MessageDTO {
  return {
    id: message.id,
    conversation_id: conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    created_at: message.createdAt,
  };
}

function roundedCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function prepareConversationContext(
  input: PrepareConversationContextInput
): Promise<PreparedConversationContext> {
  const state = getContextState(input.conversationId, input.userId);
  const messages = listConversationMessagesAfterCursor({
    conversationId: input.conversationId,
    userId: input.userId,
    cursorTime: state?.summarizedThroughCreatedAt || null,
    cursorId: state?.summarizedThroughMessageId || null,
    excludeMessageId: input.currentMessageId,
  }).filter(isModelVisibleMessage);
  const activeHistory = messages.map(message => toMessageDTO(message, input.conversationId));
  const retainCount = Math.max(answerHistoryLimit() - 1, 0);
  const tailMessages = retainCount > 0 ? messages.slice(-retainCount) : [];
  const droppedMessages = messages.slice(0, messages.length - tailMessages.length);
  const tail = tailMessages.map(message => toMessageDTO(message, input.conversationId));
  const activeTokenEstimate = estimateConversationMessagesTokenCount(messages);
  const tailTokenEstimate = estimateConversationMessagesTokenCount(tailMessages);
  const M = activeTokenEstimate * MODEL_CACHED_INPUT_PRICE_PER_MILLION / 1_000_000;
  const N = tailTokenEstimate * MODEL_INPUT_PRICE_PER_MILLION / 1_000_000;
  const costTriggered = tailTokenEstimate > 0 && M > CONVERSATION_CONTEXT_COST_RATIO * N;
  const previousUserAt = state
    ? state.lastUserMessageAt
    : getPreviousUserMessageCreatedAt({
      conversationId: input.conversationId,
      userId: input.userId,
      currentMessageId: input.currentMessageId,
    });
  const requestTime = Date.parse(input.requestAt);
  const previousUserTime = previousUserAt ? Date.parse(previousUserAt) : Number.NaN;
  const idleTriggered = Number.isFinite(requestTime)
    && Number.isFinite(previousUserTime)
    && requestTime - previousUserTime > CONVERSATION_CACHE_IDLE_MINUTES * 60_000;
  const shouldCompact = droppedMessages.length > 0 && (costTriggered || idleTriggered);
  const compactTrigger = costTriggered && idleTriggered
    ? 'cost_and_idle'
    : costTriggered ? 'cost' : 'idle';
  const contextThinkLog = shouldCompact
    ? `已将 ${droppedMessages.length} 条较早消息压缩为摘要（触发原因：${compactTrigger}）。`
    : undefined;

  let summaryText = state?.summaryText || '';
  let summaryTokenEstimate = state?.summaryTokenEstimate || 0;
  let summarizedThroughCreatedAt = state?.summarizedThroughCreatedAt || null;
  let summarizedThroughMessageId = state?.summarizedThroughMessageId || null;
  let summaryUpdated = false;

  if (shouldCompact) {
    let nextSummary: string | undefined;
    try {
      nextSummary = await summarizeConversationContext({
        existingSummary: summaryText,
        droppedMessages,
        maxTokens: CONVERSATION_SUMMARY_MAX_TOKENS,
      });
    } catch {
      nextSummary = undefined;
    }
    if (nextSummary !== undefined) {
      summaryText = nextSummary;
      summaryTokenEstimate = estimateConversationTokenCount(nextSummary);
      summaryUpdated = true;
    }
    const lastDroppedMessage = droppedMessages[droppedMessages.length - 1];
    summarizedThroughCreatedAt = lastDroppedMessage.createdAt;
    summarizedThroughMessageId = lastDroppedMessage.id;
  }

  upsertContextState({
    conversationId: input.conversationId,
    userId: input.userId,
    summaryText,
    summaryTokenEstimate,
    summarizedThroughCreatedAt,
    summarizedThroughMessageId,
    lastUserMessageAt: input.requestAt,
  });

  if (shouldCompact) {
    console.info('[conversation-context] compacted', {
      conversationId: input.conversationId,
      trigger: compactTrigger,
      M: roundedCost(M),
      N: roundedCost(N),
      activeTokenEstimate: Math.round(activeTokenEstimate),
      tailTokenEstimate: Math.round(tailTokenEstimate),
      retainedMessages: tail.length,
      droppedMessages: droppedMessages.length,
      summaryTokenEstimate: Math.round(summaryTokenEstimate),
      summaryUpdated,
    });
  }

  return {
    summaryText,
    history: shouldCompact ? tail : activeHistory,
    ...(contextThinkLog ? { contextThinkLog } : {}),
  };
}
