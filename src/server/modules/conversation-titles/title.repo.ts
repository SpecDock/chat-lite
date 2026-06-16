import { db } from '../../core/db.js';

export function updateConversationTitle(userId: string, conversationId: string, title: string) {
  db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(title, conversationId, userId);
}
