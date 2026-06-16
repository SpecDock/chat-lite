import { db, row } from '../../core/db.js';

export function updateUserAvatar(userId: string, attachmentId: string) {
  db.prepare('UPDATE users SET avatar_attachment_id=? WHERE id=?').run(attachmentId, userId);
}

export function findUserPasswordHash(userId: string) {
  return row<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', userId);
}

export function updateUserPasswordHash(userId: string, passwordHash: string) {
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, userId);
}
