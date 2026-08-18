import { db, now } from '../../core/db.js';

export function findUserAttachmentPath(attachmentId: string, userId: string, conversationId: string) {
  if (!conversationId) return undefined;
  const sql = `SELECT id,file_path,mime_type,original_name FROM attachments
    WHERE id=? AND user_id=? AND conversation_id=?`;
  const params = [attachmentId, userId, conversationId];
  return db.prepare(sql).get(...params) as { id: string; file_path: string; mime_type: string; original_name?: string | null } | undefined;
}

export function insertImageGeneration(id: string, userId: string, prompt: string, model: string | null) {
  db.prepare('INSERT INTO image_generations (id,user_id,prompt,model,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, prompt, model, 'pending', now());
}

export function completeImageGeneration(id: string, userId: string, attachmentId: string) {
  db.prepare('UPDATE image_generations SET status=?, result_attachment_id=? WHERE id=? AND user_id=?')
    .run('completed', attachmentId, id, userId);
}

export function failImageGeneration(id: string, userId: string, message: string) {
  db.prepare('UPDATE image_generations SET status=?, error=? WHERE id=? AND user_id=?')
    .run('error', message, id, userId);
}
