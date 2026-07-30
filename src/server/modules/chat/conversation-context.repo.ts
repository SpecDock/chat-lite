import { all, db, now, row } from '../../core/db.js';

export type ContextState = {
  conversationId: string;
  userId: string;
  summaryText: string;
  summaryTokenEstimate: number;
  summarizedThroughCreatedAt: string | null;
  summarizedThroughMessageId: string | null;
  lastUserMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContextMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  status: 'streaming' | 'completed' | 'interrupted' | 'error';
  content: string;
  createdAt: string;
};

export type UpsertContextStateInput = Omit<ContextState, 'createdAt' | 'updatedAt'>;

const contextStateColumns = `conversation_id AS conversationId,
  user_id AS userId,
  summary_text AS summaryText,
  summary_token_estimate AS summaryTokenEstimate,
  summarized_through_created_at AS summarizedThroughCreatedAt,
  summarized_through_message_id AS summarizedThroughMessageId,
  last_user_message_at AS lastUserMessageAt,
  created_at AS createdAt,
  updated_at AS updatedAt`;

export function getContextState(conversationId: string, userId: string) {
  return row<ContextState>(
    `SELECT ${contextStateColumns}
      FROM conversation_context_states
      WHERE conversation_id=? AND user_id=?`,
    conversationId,
    userId
  );
}

export function upsertContextState(input: UpsertContextStateInput) {
  const timestamp = now();
  db.prepare(`INSERT INTO conversation_context_states (
      conversation_id,user_id,summary_text,summary_token_estimate,
      summarized_through_created_at,summarized_through_message_id,last_user_message_at,
      created_at,updated_at
    )
    SELECT ?,c.user_id,?,?,?,?,?,?,?
      FROM conversations c
      WHERE c.id=? AND c.user_id=?
    ON CONFLICT(conversation_id) DO UPDATE SET
      summary_text=excluded.summary_text,
      summary_token_estimate=excluded.summary_token_estimate,
      summarized_through_created_at=excluded.summarized_through_created_at,
      summarized_through_message_id=excluded.summarized_through_message_id,
      last_user_message_at=excluded.last_user_message_at,
      updated_at=excluded.updated_at
    WHERE conversation_context_states.user_id=excluded.user_id`).run(
    input.conversationId,
    input.summaryText,
    input.summaryTokenEstimate,
    input.summarizedThroughCreatedAt,
    input.summarizedThroughMessageId,
    input.lastUserMessageAt,
    timestamp,
    timestamp,
    input.conversationId,
    input.userId
  );
  return getContextState(input.conversationId, input.userId);
}

export function listConversationMessagesAfterCursor(input: {
  conversationId: string;
  userId: string;
  cursorTime: string | null;
  cursorId: string | null;
  excludeMessageId?: string;
}) {
  const conditions = ['conversation_id=?', 'user_id=?'];
  const params: unknown[] = [input.conversationId, input.userId];
  if (input.cursorTime !== null && input.cursorId !== null) {
    conditions.push('(created_at>? OR (created_at=? AND id>?))');
    params.push(input.cursorTime, input.cursorTime, input.cursorId);
  }
  if (input.excludeMessageId) {
    conditions.push('id<>?');
    params.push(input.excludeMessageId);
  }
  return all<ContextMessage>(`SELECT id,role,status,content,created_at AS createdAt
    FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ASC,id ASC`, ...params);
}

export function getPreviousUserMessageCreatedAt(input: {
  conversationId: string;
  userId: string;
  currentMessageId: string;
}) {
  return row<{ createdAt: string }>(`SELECT previous.created_at AS createdAt
    FROM messages current
    JOIN messages previous
      ON previous.conversation_id=current.conversation_id
      AND previous.user_id=current.user_id
      AND previous.role='user'
      AND (previous.created_at<current.created_at
        OR (previous.created_at=current.created_at AND previous.id<current.id))
    WHERE current.id=? AND current.conversation_id=? AND current.user_id=?
    ORDER BY previous.created_at DESC,previous.id DESC
    LIMIT 1`, input.currentMessageId, input.conversationId, input.userId)?.createdAt;
}
