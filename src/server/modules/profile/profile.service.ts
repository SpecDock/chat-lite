import argon2 from 'argon2';
import { saveImageBuffer } from '../uploads/upload.js';
import * as repo from './profile.repo.js';

export class ProfileError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function updateAvatar(userId: string, email: string, file: { buffer: Buffer; filename: string; mimeType: string }) {
  if (file.buffer.length > 2 * 1024 * 1024) throw new ProfileError(400, '头像不能超过 2MB');
  const attachment = await saveImageBuffer(userId, file, undefined, 2 * 1024 * 1024, '2MB');
  repo.updateUserAvatar(userId, attachment.id);
  return { ok: true, user: { id: userId, email, avatar_url: attachment.public_path } };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, confirmPassword: string) {
  if (newPassword.length < 8) throw new ProfileError(400, '新密码至少 8 位');
  if (newPassword !== confirmPassword) throw new ProfileError(400, '两次新密码不一致');
  const user = repo.findUserPasswordHash(userId);
  if (!user || !(await argon2.verify(user.password_hash, currentPassword))) throw new ProfileError(400, '原始密码错误');
  repo.updateUserPasswordHash(userId, await argon2.hash(newPassword, { type: argon2.argon2id }));
}
