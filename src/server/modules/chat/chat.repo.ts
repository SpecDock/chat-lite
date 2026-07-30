import { all, db, now, row } from '../../core/db.js';
import { deleteConversationChunks, deleteMessageChunks } from '../rag/rag.repo.js';
import { syncMessageSearchDocument } from '../search/search.repo.js';
import type { MessageDTO } from '../../../shared/types.js';

export type ConversationRow = {
  id: string;
  title: string;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AttachmentFileRow = {
  id: string;
  file_path: string;
};

export type MessageRow = MessageDTO & { rowid: number; user_id: string };

export type MessagePair = {
  user: MessageRow;
  assistant?: MessageRow;
  isFirst: boolean;
  isLatest: boolean;
};

export type CloneAttachmentRow = AttachmentFileRow & {
  original_name: string | null;
  mime_type: string;
  size: number;
};

export function listConversations(userId: string) {
  return all<ConversationRow>('SELECT id,title,pinned_at,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY pinned_at DESC,updated_at DESC,id DESC', userId);
}

export function getConversation(conversationId: string, userId: string) {
  return row<ConversationRow>('SELECT id,title,pinned_at,created_at,updated_at FROM conversations WHERE id=? AND user_id=?', conversationId, userId);
}

export function conversationExists(conversationId: string, userId: string) {
  return !!row<{ id: string }>('SELECT id FROM conversations WHERE id=? AND user_id=?', conversationId, userId);
}

export function createConversation(conversationId: string, userId: string, title: string) {
  db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(conversationId, userId, title, now(), now());
  return getConversation(conversationId, userId);
}

export function updateConversationTitle(conversationId: string, userId: string, title: string) {
  db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=? AND title_manually_set=0').run(title, conversationId, userId);
}

export function setConversationPinned(conversationId: string, userId: string, pinned: boolean) {
  db.prepare('UPDATE conversations SET pinned_at=? WHERE id=? AND user_id=?').run(pinned ? now() : null, conversationId, userId);
  return getConversation(conversationId, userId);
}

export function renameConversation(conversationId: string, userId: string, title: string) {
  db.prepare('UPDATE conversations SET title=?,title_manually_set=1 WHERE id=? AND user_id=?').run(title, conversationId, userId);
  return getConversation(conversationId, userId);
}

export function touchConversation(conversationId: string, userId: string) {
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?').run(now(), conversationId, userId);
}

export function deleteConversationData(conversationId: string, userId: string) {
  const attachments = all<AttachmentFileRow>('SELECT id,file_path FROM attachments WHERE conversation_id=? AND user_id=?', conversationId, userId);
  const attachmentIds = attachments.map(a => a.id);
  const removeConversation = db.transaction(() => {
    if (attachmentIds.length) {
      const placeholders = attachmentIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET avatar_attachment_id=NULL WHERE avatar_attachment_id IN (${placeholders}) AND id=?`).run(...attachmentIds, userId);
      db.prepare(`DELETE FROM image_generations WHERE result_attachment_id IN (${placeholders}) AND user_id=?`).run(...attachmentIds, userId);
      db.prepare(`DELETE FROM attachments WHERE id IN (${placeholders}) AND user_id=?`).run(...attachmentIds, userId);
    }
    db.prepare('DELETE FROM messages WHERE conversation_id=? AND user_id=?').run(conversationId, userId);
    db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(conversationId, userId);
  });
  removeConversation();
  // RAG chunks live in a separate database (rag.db), so we can't fold the
  // cleanup into the SQL transaction above. Run it immediately after the
  // transaction commits; failures are logged but do not roll back the
  // conversation deletion itself. deleteConversationChunks also wipes the
  // matching vec_rag_items rowids in the same call.
  try {
    const removed = deleteConversationChunks(conversationId);
    if (removed > 0) console.info(`[rag] deleted ${removed} chunks for conversation=${conversationId}`);
  } catch (error) {
    console.warn('[rag] chunk cleanup failed for conversation', conversationId, error instanceof Error ? error.message : error);
  }
  return attachments;
}

export function listMessages(conversationId: string, userId: string) {
  return all<MessageDTO>('SELECT id,conversation_id,role,content,status,created_at FROM messages WHERE conversation_id=? AND user_id=? ORDER BY created_at ASC, rowid ASC', conversationId, userId);
}

export function listChatHistoryPage(conversationId: string, userId: string, limit: number, offset: number) {
  return all<Pick<MessageDTO, 'id' | 'role' | 'content' | 'status'>>("SELECT id,role,content,status FROM messages WHERE conversation_id=? AND user_id=? AND status IN ('completed','interrupted') ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?", conversationId, userId, limit, offset);
}

export function conversationHasStreamingAssistant(conversationId: string, userId: string) {
  return !!row<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND user_id=? AND role='assistant' AND status='streaming' LIMIT 1", conversationId, userId);
}

export function getMessagePair(conversationId: string, userId: string, userMessageId: string): MessagePair | undefined {
  const user = row<MessageRow>("SELECT rowid,id,user_id,conversation_id,role,content,status,created_at FROM messages WHERE id=? AND conversation_id=? AND user_id=? AND role='user'", userMessageId, conversationId, userId);
  if (!user) return undefined;
  const assistant = row<MessageRow>(`SELECT rowid,id,user_id,conversation_id,role,content,status,created_at
    FROM messages candidate
    WHERE candidate.conversation_id=? AND candidate.user_id=? AND candidate.role='assistant' AND candidate.rowid>?
      AND NOT EXISTS (
        SELECT 1 FROM messages boundary
        WHERE boundary.conversation_id=candidate.conversation_id AND boundary.user_id=candidate.user_id
          AND boundary.role='user' AND boundary.rowid>? AND boundary.rowid<candidate.rowid
      )
    ORDER BY candidate.rowid ASC LIMIT 1`, conversationId, userId, user.rowid, user.rowid);
  const firstUser = row<{ rowid: number }>("SELECT rowid FROM messages WHERE conversation_id=? AND user_id=? AND role='user' ORDER BY rowid ASC LIMIT 1", conversationId, userId);
  const latestUser = row<{ rowid: number }>("SELECT rowid FROM messages WHERE conversation_id=? AND user_id=? AND role='user' ORDER BY rowid DESC LIMIT 1", conversationId, userId);
  return {
    user,
    assistant,
    isFirst: firstUser?.rowid === user.rowid,
    isLatest: latestUser?.rowid === user.rowid
  };
}

export function listMessageAttachments(messageId: string, conversationId: string, userId: string) {
  return all<CloneAttachmentRow>('SELECT id,file_path,original_name,mime_type,size FROM attachments WHERE message_id=? AND conversation_id=? AND user_id=? ORDER BY created_at ASC, rowid ASC', messageId, conversationId, userId);
}

export function insertClonedAttachment(input: {
  id: string;
  userId: string;
  conversationId: string;
  originalName: string | null;
  filePath: string;
  publicPath: string;
  mimeType: string;
  size: number;
}) {
  db.prepare(`INSERT INTO attachments (id,user_id,conversation_id,original_name,file_path,public_path,mime_type,size,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id, input.userId, input.conversationId, input.originalName, input.filePath, input.publicPath, input.mimeType, input.size, now());
}

export function deleteUnlinkedAttachments(attachmentIds: string[], userId: string) {
  if (!attachmentIds.length) return;
  const placeholders = attachmentIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM attachments WHERE id IN (${placeholders}) AND user_id=? AND message_id IS NULL`).run(...attachmentIds, userId);
}

function messageRowsForPair(conversationId: string, userId: string, userMessageId: string) {
  const pair = getMessagePair(conversationId, userId, userMessageId);
  if (!pair) throw Object.assign(new Error('用户消息不存在'), { status: 404 });
  return pair;
}

function attachmentsForRemoval(conversationId: string, userId: string, messageIds: string[], referencedAttachmentIds: string[], protectMessageId?: string) {
  const clauses: string[] = [];
  const params: unknown[] = [conversationId, userId];
  if (messageIds.length) {
    clauses.push(`message_id IN (${messageIds.map(() => '?').join(',')})`);
    params.push(...messageIds);
  }
  if (referencedAttachmentIds.length) {
    clauses.push(`(id IN (${referencedAttachmentIds.map(() => '?').join(',')}) AND message_id IS NULL)`);
    params.push(...referencedAttachmentIds);
  }
  if (!clauses.length) return [];
  let sql = `SELECT id,file_path FROM attachments WHERE conversation_id=? AND user_id=? AND (${clauses.join(' OR ')})`;
  if (protectMessageId) {
    sql += ' AND (message_id IS NULL OR message_id<>?)';
    params.push(protectMessageId);
  }
  return all<AttachmentFileRow>(sql, ...params);
}

function deleteAttachmentRows(attachments: AttachmentFileRow[], userId: string) {
  if (!attachments.length) return;
  const attachmentIds = attachments.map(attachment => attachment.id);
  const placeholders = attachmentIds.map(() => '?').join(',');
  db.prepare(`UPDATE users SET avatar_attachment_id=NULL WHERE avatar_attachment_id IN (${placeholders}) AND id=?`).run(...attachmentIds, userId);
  db.prepare(`DELETE FROM image_generations WHERE result_attachment_id IN (${placeholders}) AND user_id=?`).run(...attachmentIds, userId);
  db.prepare(`DELETE FROM attachments WHERE id IN (${placeholders}) AND user_id=?`).run(...attachmentIds, userId);
}

export function deleteMessagePairData(input: {
  conversationId: string;
  userId: string;
  userMessageId: string;
  referencedAttachmentIds: string[];
}) {
  const removePair = db.transaction(() => {
    if (conversationHasStreamingAssistant(input.conversationId, input.userId)) {
      throw Object.assign(new Error('会话正在生成回复'), { status: 409 });
    }
    const pair = messageRowsForPair(input.conversationId, input.userId, input.userMessageId);
    const messageIds = [pair.user.id, ...(pair.assistant ? [pair.assistant.id] : [])];
    const attachments = attachmentsForRemoval(input.conversationId, input.userId, messageIds, input.referencedAttachmentIds);
    deleteAttachmentRows(attachments, input.userId);
    db.prepare(`DELETE FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')}) AND conversation_id=? AND user_id=?`).run(...messageIds, input.conversationId, input.userId);
    const remainingUserCount = row<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND user_id=? AND role='user'", input.conversationId, input.userId)?.count || 0;
    if (!remainingUserCount) {
      const remainingAttachments = all<AttachmentFileRow>('SELECT id,file_path FROM attachments WHERE conversation_id=? AND user_id=?', input.conversationId, input.userId);
      deleteAttachmentRows(remainingAttachments, input.userId);
      db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(input.conversationId, input.userId);
      const removedFiles = new Map([...attachments, ...remainingAttachments].map(attachment => [attachment.id, attachment]));
      return { pair, messageIds, attachments: [...removedFiles.values()], conversationDeleted: true as const, nextPair: undefined };
    }
    touchConversation(input.conversationId, input.userId);
    const nextUser = row<MessageRow>("SELECT rowid,id,user_id,conversation_id,role,content,status,created_at FROM messages WHERE conversation_id=? AND user_id=? AND role='user' ORDER BY rowid ASC LIMIT 1", input.conversationId, input.userId);
    const nextPair = nextUser ? getMessagePair(input.conversationId, input.userId, nextUser.id) : undefined;
    return { pair, messageIds, attachments, conversationDeleted: false as const, nextPair };
  });
  const result = removePair();
  try {
    if (result.conversationDeleted) deleteConversationChunks(input.conversationId);
    else for (const messageId of result.messageIds) deleteMessageChunks(input.userId, messageId);
  } catch (error) {
    console.warn('[rag] message-pair cleanup failed:', error instanceof Error ? error.message : error);
  }
  return result;
}

export function replaceLatestMessagePair(input: {
  conversationId: string;
  userId: string;
  userMessageId: string;
  userContent: string;
  newAssistantId: string;
  referencedAssistantAttachmentIds: string[];
}) {
  const replacePair = db.transaction(() => {
    if (conversationHasStreamingAssistant(input.conversationId, input.userId)) {
      throw Object.assign(new Error('会话正在生成回复'), { status: 409 });
    }
    const pair = messageRowsForPair(input.conversationId, input.userId, input.userMessageId);
    if (!pair.isLatest) throw Object.assign(new Error('该消息已不是最新问题'), { status: 409 });
    const assistantMessageIds = pair.assistant ? [pair.assistant.id] : [];
    const attachments = attachmentsForRemoval(input.conversationId, input.userId, assistantMessageIds, input.referencedAssistantAttachmentIds, pair.user.id);
    deleteAttachmentRows(attachments, input.userId);
    db.prepare("UPDATE messages SET content=?,status='completed' WHERE id=? AND conversation_id=? AND user_id=? AND role='user'").run(input.userContent, pair.user.id, input.conversationId, input.userId);
    syncMessageSearchDocument(pair.user.id);
    const assistantId = pair.assistant?.id || input.newAssistantId;
    if (pair.assistant) {
      db.prepare("UPDATE messages SET content='',status='streaming' WHERE id=? AND conversation_id=? AND user_id=? AND role='assistant'").run(assistantId, input.conversationId, input.userId);
      syncMessageSearchDocument(assistantId);
    } else {
      insertAssistantStreamingMessage(assistantId, input.userId, input.conversationId);
    }
    touchConversation(input.conversationId, input.userId);
    return { pair, assistantId, attachments };
  });
  const result = replacePair();
  try {
    deleteMessageChunks(input.userId, result.pair.user.id);
    if (result.pair.assistant) deleteMessageChunks(input.userId, result.pair.assistant.id);
  } catch (error) {
    console.warn('[rag] edited message cleanup failed:', error instanceof Error ? error.message : error);
  }
  return result;
}

export function appendEditedMessagePair(input: {
  conversationId: string;
  userId: string;
  originalUserMessageId: string;
  userMessageId: string;
  assistantId: string;
  userContent: string;
  attachmentIds: string[];
}) {
  const appendPair = db.transaction(() => {
    if (conversationHasStreamingAssistant(input.conversationId, input.userId)) {
      throw Object.assign(new Error('会话正在生成回复'), { status: 409 });
    }
    const originalPair = messageRowsForPair(input.conversationId, input.userId, input.originalUserMessageId);
    if (originalPair.isLatest) throw Object.assign(new Error('该消息已变为最新问题，请重试编辑'), { status: 409 });
    insertUserMessage(input.userMessageId, input.userId, input.conversationId, input.userContent);
    linkAttachmentsToMessage(input.attachmentIds, input.userId, input.conversationId, input.userMessageId);
    insertAssistantStreamingMessage(input.assistantId, input.userId, input.conversationId);
    touchConversation(input.conversationId, input.userId);
  });
  appendPair();
}

export function countValidAttachments(attachmentIds: string[], userId: string, conversationId: string) {
  if (!attachmentIds.length) return 0;
  const placeholders = attachmentIds.map(() => '?').join(',');
  return row<{ count: number }>(`SELECT COUNT(*) as count FROM attachments WHERE id IN (${placeholders}) AND user_id=? AND mime_type LIKE 'image/%' AND message_id IS NULL AND (conversation_id IS NULL OR conversation_id=?)`, ...attachmentIds, userId, conversationId)?.count || 0;
}

export function insertUserMessage(messageId: string, userId: string, conversationId: string, content: string) {
  db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)').run(messageId, userId, conversationId, 'user', content, 'completed', now());
  syncMessageSearchDocument(messageId);
}

export function linkAttachmentsToMessage(attachmentIds: string[], userId: string, conversationId: string, messageId: string) {
  if (!attachmentIds.length) return;
  const placeholders = attachmentIds.map(() => '?').join(',');
  db.prepare(`UPDATE attachments SET conversation_id=?, message_id=? WHERE id IN (${placeholders}) AND user_id=? AND mime_type LIKE 'image/%' AND message_id IS NULL AND (conversation_id IS NULL OR conversation_id=?)`).run(conversationId, messageId, ...attachmentIds, userId, conversationId);
}

export function insertAssistantStreamingMessage(messageId: string, userId: string, conversationId: string) {
  db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)').run(messageId, userId, conversationId, 'assistant', '', 'streaming', now());
  syncMessageSearchDocument(messageId);
}

export function completeAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'completed', messageId, userId);
  syncMessageSearchDocument(messageId);
}

export function interruptAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'interrupted', messageId, userId);
  syncMessageSearchDocument(messageId);
}

export function failAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'error', messageId, userId);
  syncMessageSearchDocument(messageId);
}
