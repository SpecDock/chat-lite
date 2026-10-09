import { db } from '../db/db.js';

export function updateConversationTitle(userId: string, conversationId: string, title: string) {
  return db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=? AND title_manually_set=0')
    .run(title, conversationId, userId).changes > 0;
}
