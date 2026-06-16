import { all, db, now, row } from '../../core/db.js';
import type { MessageDTO } from '../../../shared/types.js';

export type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type AttachmentFileRow = {
  id: string;
  file_path: string;
};

export function listConversations(userId: string) {
  return all<ConversationRow>('SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC', userId);
}

export function getConversation(conversationId: string, userId: string) {
  return row<ConversationRow>('SELECT id,title,created_at,updated_at FROM conversations WHERE id=? AND user_id=?', conversationId, userId);
}

export function conversationExists(conversationId: string, userId: string) {
  return !!row<{ id: string }>('SELECT id FROM conversations WHERE id=? AND user_id=?', conversationId, userId);
}

export function createConversation(conversationId: string, userId: string, title: string) {
  db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(conversationId, userId, title, now(), now());
  return getConversation(conversationId, userId);
}

export function updateConversationTitle(conversationId: string, userId: string, title: string) {
  db.prepare('UPDATE conversations SET title=?, updated_at=? WHERE id=? AND user_id=?').run(title, now(), conversationId, userId);
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
  return attachments;
}

export function listMessages(conversationId: string, userId: string) {
  return all<MessageDTO>('SELECT id,conversation_id,role,content,status,created_at FROM messages WHERE conversation_id=? AND user_id=? ORDER BY created_at ASC', conversationId, userId);
}

export function listChatHistory(conversationId: string, userId: string) {
  return all<MessageDTO>("SELECT role,content FROM messages WHERE conversation_id=? AND user_id=? AND status IN ('completed','interrupted') ORDER BY created_at ASC LIMIT 30", conversationId, userId);
}

export function countValidAttachments(attachmentIds: string[], userId: string) {
  if (!attachmentIds.length) return 0;
  const placeholders = attachmentIds.map(() => '?').join(',');
  return row<{ count: number }>(`SELECT COUNT(*) as count FROM attachments WHERE id IN (${placeholders}) AND user_id=?`, ...attachmentIds, userId)?.count || 0;
}

export function insertUserMessage(messageId: string, userId: string, conversationId: string, content: string) {
  db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)').run(messageId, userId, conversationId, 'user', content, 'completed', now());
}

export function linkAttachmentsToMessage(attachmentIds: string[], userId: string, conversationId: string, messageId: string) {
  if (!attachmentIds.length) return;
  const placeholders = attachmentIds.map(() => '?').join(',');
  db.prepare(`UPDATE attachments SET conversation_id=?, message_id=? WHERE id IN (${placeholders}) AND user_id=?`).run(conversationId, messageId, ...attachmentIds, userId);
}

export function insertAssistantStreamingMessage(messageId: string, userId: string, conversationId: string) {
  db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)').run(messageId, userId, conversationId, 'assistant', '', 'streaming', now());
}

export function completeAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'completed', messageId, userId);
}

export function interruptAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'interrupted', messageId, userId);
}

export function failAssistantMessage(messageId: string, userId: string, content: string) {
  db.prepare('UPDATE messages SET content=?, status=? WHERE id=? AND user_id=?').run(content, 'error', messageId, userId);
}
