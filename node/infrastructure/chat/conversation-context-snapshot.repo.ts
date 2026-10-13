import { db, now, row } from '../db/db.js';

export type ContextSnapshotStatus = 'pending' | 'current' | 'superseded' | 'invalid';

export type ContextSnapshotRecord = {
  id: string;
  version: number;
  conversationId: string;
  userId: string;
  coveredMessageId: string;
  coveredMessageCreatedAt: string;
  contextJson: string;
  status: ContextSnapshotStatus;
  createdAt: string;
};

export type InsertPendingContextSnapshotInput = {
  id: string;
  conversationId: string;
  userId: string;
  coveredMessageId: string;
  coveredMessageCreatedAt: string;
  contextJson: string;
};

export type ContextSnapshotIdentity = {
  snapshotId: string;
  conversationId: string;
  userId: string;
};

const snapshotColumns = `id,
  version,
  conversation_id AS conversationId,
  user_id AS userId,
  covered_message_id AS coveredMessageId,
  covered_message_created_at AS coveredMessageCreatedAt,
  context_json AS contextJson,
  status,
  created_at AS createdAt`;

export function getContextSnapshotRecord(snapshotId: string, conversationId: string, userId: string) {
  return row<ContextSnapshotRecord>(
    `SELECT ${snapshotColumns}
      FROM conversation_context_snapshots
      WHERE id=? AND conversation_id=? AND user_id=?`,
    snapshotId,
    conversationId,
    userId
  );
}

export function getCurrentContextSnapshotRecord(conversationId: string, userId: string) {
  return row<ContextSnapshotRecord>(
    `SELECT ${snapshotColumns}
      FROM conversation_context_snapshots
      WHERE conversation_id=? AND user_id=? AND status='current'
      ORDER BY version DESC
      LIMIT 1`,
    conversationId,
    userId
  );
}

export function insertPendingContextSnapshot(input: InsertPendingContextSnapshotInput) {
  const timestamp = now();
  const inserted = db.prepare(`INSERT INTO conversation_context_snapshots (
      id, conversation_id, user_id, version,
      covered_message_id, covered_message_created_at,
      context_json, status, created_at
    )
    SELECT ?, c.id, c.user_id,
      COALESCE((
        SELECT MAX(version) FROM conversation_context_snapshots existing
        WHERE existing.conversation_id=c.id AND existing.user_id=c.user_id
      ), 0) + 1,
      ?, ?, ?, 'pending', ?
    FROM conversations c
    WHERE c.id=? AND c.user_id=?`).run(
    input.id,
    input.coveredMessageId,
    input.coveredMessageCreatedAt,
    input.contextJson,
    timestamp,
    input.conversationId,
    input.userId
  );
  if (inserted.changes !== 1) return undefined;
  const snapshot = getContextSnapshotRecord(input.id, input.conversationId, input.userId);
  if (!snapshot) throw new Error('context snapshot insert did not persist');
  return snapshot;
}

export function commitContextSnapshotRecord(input: ContextSnapshotIdentity) {
  // Supersede and promote together. A throw rolls back, so the previous current row stays current.
  const commit = db.transaction(() => {
    const pending = getContextSnapshotRecord(input.snapshotId, input.conversationId, input.userId);
    if (!pending || pending.status !== 'pending') {
      throw new Error('context snapshot is not a pending version for this conversation');
    }
    db.prepare(`UPDATE conversation_context_snapshots
      SET status='superseded'
      WHERE conversation_id=? AND user_id=? AND status='current'`).run(input.conversationId, input.userId);
    const promoted = db.prepare(`UPDATE conversation_context_snapshots
      SET status='current'
      WHERE id=? AND conversation_id=? AND user_id=? AND status='pending'`).run(
      input.snapshotId,
      input.conversationId,
      input.userId
    );
    if (promoted.changes !== 1) throw new Error('context snapshot commit failed');
    const current = getCurrentContextSnapshotRecord(input.conversationId, input.userId);
    if (!current || current.id !== input.snapshotId) throw new Error('context snapshot commit failed');
    return current;
  });
  return commit();
}

export function failContextSnapshotRecord(input: ContextSnapshotIdentity) {
  const fail = db.transaction(() => {
    const pending = getContextSnapshotRecord(input.snapshotId, input.conversationId, input.userId);
    if (!pending || pending.status !== 'pending') {
      throw new Error('context snapshot is not a pending version for this conversation');
    }
    const currentBefore = getCurrentContextSnapshotRecord(input.conversationId, input.userId)?.id ?? null;
    const failed = db.prepare(`UPDATE conversation_context_snapshots
      SET status='invalid'
      WHERE id=? AND conversation_id=? AND user_id=? AND status='pending'`).run(
      input.snapshotId,
      input.conversationId,
      input.userId
    );
    if (failed.changes !== 1) throw new Error('context snapshot failure did not apply');
    const currentAfter = getCurrentContextSnapshotRecord(input.conversationId, input.userId)?.id ?? null;
    if (currentBefore !== currentAfter) throw new Error('context snapshot failure changed the current version');
    const snapshot = getContextSnapshotRecord(input.snapshotId, input.conversationId, input.userId);
    if (!snapshot || snapshot.status !== 'invalid') throw new Error('context snapshot failure did not apply');
    return snapshot;
  });
  return fail();
}

export function invalidateContextSnapshotsAfterCursor(input: {
  conversationId: string;
  userId: string;
  cursorTime: string;
  cursorId: string;
}) {
  const invalidated = db.prepare(`UPDATE conversation_context_snapshots
    SET status='invalid'
    WHERE conversation_id=? AND user_id=?
      AND status<>'invalid'
      AND (
        covered_message_created_at>?
        OR (covered_message_created_at=? AND covered_message_id>?)
      )`).run(
    input.conversationId,
    input.userId,
    input.cursorTime,
    input.cursorTime,
    input.cursorId
  );
  return invalidated.changes;
}

export function invalidateContextSnapshotsFromCursor(input: {
  conversationId: string;
  userId: string;
  cursorTime: string;
  cursorId: string;
}) {
  // Message ids are random, so same-millisecond user and assistant rows cannot
  // be ordered by id. Inclusive invalidation therefore uses the timestamp only.
  const invalidated = db.prepare(`UPDATE conversation_context_snapshots
    SET status='invalid'
    WHERE conversation_id=? AND user_id=?
      AND status<>'invalid'
      AND covered_message_created_at>=?`).run(
    input.conversationId,
    input.userId,
    input.cursorTime
  );
  return invalidated.changes;
}

export function invalidateAllContextSnapshots(input: {
  conversationId: string;
  userId: string;
}) {
  const invalidated = db.prepare(`UPDATE conversation_context_snapshots
    SET status='invalid'
    WHERE conversation_id=? AND user_id=?
      AND status<>'invalid'`).run(input.conversationId, input.userId);
  return invalidated.changes;
}
