import { db, now, row } from '../db/db.js';

export function insertAttachment(input: { id: string; userId: string; conversationId?: string; originalName: string; filePath: string; publicPath: string; mimeType: string; size: number }) {
  const createdAt = now();
  db.prepare(`INSERT INTO attachments (id,user_id,conversation_id,original_name,file_path,public_path,mime_type,size,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(input.id, input.userId, input.conversationId || null, input.originalName, input.filePath, input.publicPath, input.mimeType, input.size, createdAt);
  return createdAt;
}

export function userConversationExists(conversationId: string, userId: string) {
  return Boolean(db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, userId));
}

export function findUserAttachment(attachmentId: string, userId: string) {
  return row<{ file_path: string; mime_type: string; original_name: string }>(
    'SELECT file_path,mime_type,original_name FROM attachments WHERE id=? AND user_id=?', attachmentId, userId);
}

export function findAttachment(attachmentId: string) {
  return row<{ file_path: string; mime_type: string; original_name: string }>(
    'SELECT file_path,mime_type,original_name FROM attachments WHERE id=?', attachmentId);
}
