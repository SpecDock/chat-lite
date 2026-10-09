import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { newId, reserveEmailCodeRateLimit, sha256 } from '../../infrastructure/auth/security.js';
import * as authRepo from '../../infrastructure/auth/auth.repo.js';
import { sendEmailCode } from '../../infrastructure/auth/mail.js';
import { saveImageBuffer } from '../../interfaces/http/upload.js';
import * as repo from '../../infrastructure/profile/profile.repo.js';

export class ProfileError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const passwordCodeTtlMs = 10 * 60_000;
const maxPasswordCodeAttempts = 3;
const emailCodeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export async function updateAvatar(userId: string, email: string, file: { buffer: Buffer; filename: string; mimeType: string }) {
  if (file.buffer.length > 2 * 1024 * 1024) throw new ProfileError(400, '头像不能超过 2MB');
  const attachment = await saveImageBuffer(userId, file, undefined, 2 * 1024 * 1024, '2MB');
  repo.updateUserAvatar(userId, attachment.id);
  return { ok: true, user: { id: userId, email, avatar_url: attachment.public_path } };
}

function createEmailCode() {
  return String(randomInt(100000, 1_000_000));
}

function verifyPasswordChangeCode(email: string, code: string) {
  const rec = authRepo.findLatestEmailCode(email, 'password_change');
  if (!rec || rec.used_at || Date.parse(rec.expires_at) <= Date.now()) throw new ProfileError(400, '验证码无效或已过期');
  if (rec.attempts >= maxPasswordCodeAttempts) throw new ProfileError(400, '验证码尝试次数过多');
  authRepo.incrementEmailCodeAttempts(rec.id);
  if (rec.code_hash !== emailCodeHash(email, code)) throw new ProfileError(400, '验证码错误');
  return rec;
}

export async function sendPasswordChangeCode(email: string, ip: string) {
  if (!reserveEmailCodeRateLimit(email, ip)) throw new ProfileError(429, '请求过于频繁，请稍后再试');
  const code = createEmailCode();
  try {
    await sendEmailCode(email, code, 'password_change');
  } catch (error) {
    throw new ProfileError(502, error instanceof Error ? error.message : '邮件发送失败');
  }
  authRepo.insertEmailCode(newId('code'), email, emailCodeHash(email, code), 'password_change', new Date(Date.now() + passwordCodeTtlMs).toISOString());
}

export async function changePassword(userId: string, email: string, code: string, newPassword: string, confirmPassword: string) {
  if (newPassword.length < 8) throw new ProfileError(400, '新密码至少 8 位');
  if (newPassword !== confirmPassword) throw new ProfileError(400, '两次新密码不一致');
  const rec = verifyPasswordChangeCode(email, code);
  repo.updateUserPasswordHash(userId, await argon2.hash(newPassword, { type: argon2.argon2id }));
  authRepo.deleteUserSessions(userId);
  authRepo.markEmailCodeUsed(rec.id);
  return { ok: true };
}
