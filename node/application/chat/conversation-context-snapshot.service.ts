import { newId } from '../../infrastructure/auth/security.js';
import {
  parseModelContext,
  serializeModelContext,
  type ModelContextContentBlock,
  type ModelContextImageBlock,
  type ModelContextMessage,
  type ModelContextRole,
  type ModelContextTextBlock,
  type ModelContextToolCall,
} from './conversation-context-snapshot.format.js';
import {
  commitContextSnapshotRecord,
  failContextSnapshotRecord,
  getContextSnapshotRecord,
  getCurrentContextSnapshotRecord,
  insertPendingContextSnapshot,
  invalidateAllContextSnapshots as invalidateAllContextSnapshotRows,
  invalidateContextSnapshotsAfterCursor as invalidateContextSnapshotRowsAfterCursor,
  invalidateContextSnapshotsFromCursor as invalidateContextSnapshotRowsFromCursor,
  type ContextSnapshotRecord,
  type ContextSnapshotStatus,
} from '../../infrastructure/chat/conversation-context-snapshot.repo.js';

export type {
  ModelContextContentBlock,
  ModelContextImageBlock,
  ModelContextMessage,
  ModelContextRole,
  ModelContextTextBlock,
  ModelContextToolCall,
  ContextSnapshotStatus,
};
export { parseModelContext, serializeModelContext };

export type ContextSnapshot = {
  id: string;
  version: number;
  conversationId: string;
  userId: string;
  coveredMessageId: string;
  coveredMessageCreatedAt: string;
  messages: ModelContextMessage[];
  status: ContextSnapshotStatus;
  createdAt: string;
};

export type CreatePendingContextSnapshotInput = {
  conversationId: string;
  userId: string;
  coveredMessageId: string;
  coveredMessageCreatedAt: string;
  messages: readonly ModelContextMessage[];
};

export type ContextSnapshotSelector = {
  snapshotId: string;
  conversationId: string;
  userId: string;
};

function requiredText(value: string, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function toSnapshot(record: ContextSnapshotRecord): ContextSnapshot {
  return {
    id: record.id,
    version: record.version,
    conversationId: record.conversationId,
    userId: record.userId,
    coveredMessageId: record.coveredMessageId,
    coveredMessageCreatedAt: record.coveredMessageCreatedAt,
    messages: parseModelContext(record.contextJson),
    status: record.status,
    createdAt: record.createdAt,
  };
}

export function createPendingContextSnapshot(input: CreatePendingContextSnapshotInput) {
  const conversationId = requiredText(input.conversationId, 'conversationId');
  const userId = requiredText(input.userId, 'userId');
  const coveredMessageId = requiredText(input.coveredMessageId, 'coveredMessageId');
  const coveredMessageCreatedAt = requiredText(input.coveredMessageCreatedAt, 'coveredMessageCreatedAt');
  const contextJson = serializeModelContext(input.messages);
  const record = insertPendingContextSnapshot({
    id: newId('snapshot'),
    conversationId,
    userId,
    coveredMessageId,
    coveredMessageCreatedAt,
    contextJson,
  });
  return record ? toSnapshot(record) : undefined;
}

export function commitContextSnapshot(input: ContextSnapshotSelector) {
  return toSnapshot(commitContextSnapshotRecord({
    snapshotId: requiredText(input.snapshotId, 'snapshotId'),
    conversationId: requiredText(input.conversationId, 'conversationId'),
    userId: requiredText(input.userId, 'userId'),
  }));
}

export function failContextSnapshot(input: ContextSnapshotSelector) {
  return toSnapshot(failContextSnapshotRecord({
    snapshotId: requiredText(input.snapshotId, 'snapshotId'),
    conversationId: requiredText(input.conversationId, 'conversationId'),
    userId: requiredText(input.userId, 'userId'),
  }));
}

export function getContextSnapshot(snapshotId: string, conversationId: string, userId: string) {
  const record = getContextSnapshotRecord(
    requiredText(snapshotId, 'snapshotId'),
    requiredText(conversationId, 'conversationId'),
    requiredText(userId, 'userId')
  );
  return record ? toSnapshot(record) : undefined;
}

export function getCurrentContextSnapshot(conversationId: string, userId: string) {
  const record = getCurrentContextSnapshotRecord(
    requiredText(conversationId, 'conversationId'),
    requiredText(userId, 'userId')
  );
  return record ? toSnapshot(record) : undefined;
}

export function invalidateContextSnapshotsAfterCursor(input: {
  conversationId: string;
  userId: string;
  cursorTime: string;
  cursorId: string;
}) {
  return invalidateContextSnapshotRowsAfterCursor({
    conversationId: requiredText(input.conversationId, 'conversationId'),
    userId: requiredText(input.userId, 'userId'),
    cursorTime: requiredText(input.cursorTime, 'cursorTime'),
    cursorId: requiredText(input.cursorId, 'cursorId'),
  });
}

export function invalidateContextSnapshotsFromCursor(input: {
  conversationId: string;
  userId: string;
  cursorTime: string;
  cursorId: string;
}) {
  return invalidateContextSnapshotRowsFromCursor({
    conversationId: requiredText(input.conversationId, 'conversationId'),
    userId: requiredText(input.userId, 'userId'),
    cursorTime: requiredText(input.cursorTime, 'cursorTime'),
    cursorId: requiredText(input.cursorId, 'cursorId'),
  });
}

export function invalidateAllContextSnapshots(input: {
  conversationId: string;
  userId: string;
}) {
  return invalidateAllContextSnapshotRows({
    conversationId: requiredText(input.conversationId, 'conversationId'),
    userId: requiredText(input.userId, 'userId'),
  });
}
