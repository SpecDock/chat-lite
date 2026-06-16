import { db, now, row } from '../../core/db.js';

export type AuthUserRow = { id: string; email: string; password_hash: string };
export type UserProfileRow = { created_at: string; avatar_attachment_id?: string };
export type EmailCodeRow = { id: string; code_hash: string; expires_at: string; attempts: number; used_at?: string };

export function findUserProfile(userId: string) {
  return row<UserProfileRow>('SELECT created_at,avatar_attachment_id FROM users WHERE id=?', userId);
}

export function findUserByEmail(email: string) {
  return row<AuthUserRow>('SELECT * FROM users WHERE email=?', email);
}

export function insertSession(id: string, userId: string, tokenHash: string, expiresAt: string) {
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(id, userId, tokenHash, expiresAt, now());
}

export function deleteSession(sessionId: string) {
  db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

export function insertEmailCode(id: string, email: string, codeHash: string, purpose: string, expiresAt: string) {
  db.prepare('INSERT INTO email_codes (id,email,code_hash,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, email, codeHash, purpose, expiresAt, now());
}

export function findLatestRegisterCode(email: string) {
  return row<EmailCodeRow>(`SELECT * FROM email_codes WHERE email=? AND purpose='register' ORDER BY created_at DESC LIMIT 1`, email);
}

export function incrementEmailCodeAttempts(id: string) {
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id=?').run(id);
}

export function markEmailCodeUsed(id: string) {
  db.prepare('UPDATE email_codes SET used_at=? WHERE id=?').run(now(), id);
}

export function insertUser(id: string, email: string, passwordHash: string) {
  db.prepare('INSERT INTO users (id,email,password_hash,email_verified_at,created_at) VALUES (?,?,?,?,?)')
    .run(id, email, passwordHash, now(), now());
}
