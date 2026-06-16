import argon2 from 'argon2';
import { cookieName, newId, newToken, sha256 } from '../../core/security.js';
import { sendEmailCode } from './mail.js';
import * as repo from './auth.repo.js';

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v: unknown) => String(v || '').trim().toLowerCase();
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function userDto(userId: string, email: string) {
  const user = repo.findUserProfile(userId);
  return {
    id: userId,
    email,
    created_at: user?.created_at,
    avatar_url: user?.avatar_attachment_id ? `/api/files/${user.avatar_attachment_id}` : null
  };
}

function assertEmail(email: string) {
  if (!emailRe.test(email)) throw new AuthError(400, '邮箱格式不正确');
}

function assertInvite(inviteCode: string) {
  if (!process.env.INVITE_CODE || inviteCode !== process.env.INVITE_CODE) throw new AuthError(400, '邀请码无效');
}

function sessionCookie(token: string, ttlDays: number) {
  return { name: cookieName, value: token, options: { httpOnly: true, sameSite: 'Lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: ttlDays * 86400 } };
}

function issueSession(userId: string, email: string) {
  const token = newToken();
  const ttlDays = Number(process.env.SESSION_TTL_DAYS || 30);
  repo.insertSession(newId('sess'), userId, sha256(token), new Date(Date.now() + ttlDays * 86400_000).toISOString());
  return { cookie: sessionCookie(token, ttlDays), user: userDto(userId, email) };
}

export async function sendRegisterCode(email: string, inviteCode: string) {
  assertEmail(email);
  assertInvite(inviteCode);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await sendEmailCode(email, code);
  } catch (error) {
    throw new AuthError(502, error instanceof Error ? error.message : '邮件发送失败');
  }
  repo.insertEmailCode(newId('code'), email, codeHash(email, code), 'register', new Date(Date.now() + 10 * 60_000).toISOString());
}

export async function registerUser(email: string, password: string, code: string, inviteCode: string) {
  assertEmail(email);
  if (password.length < 8) throw new AuthError(400, '密码至少 8 位');
  assertInvite(inviteCode);
  const rec = repo.findLatestRegisterCode(email);
  if (!rec || rec.used_at || Date.parse(rec.expires_at) < Date.now()) throw new AuthError(400, '验证码无效或已过期');
  if (rec.attempts >= 5) throw new AuthError(400, '验证码尝试次数过多');
  repo.incrementEmailCodeAttempts(rec.id);
  if (rec.code_hash !== codeHash(email, code)) throw new AuthError(400, '验证码错误');
  const id = newId('user');
  try {
    repo.insertUser(id, email, await argon2.hash(password, { type: argon2.argon2id }));
    repo.markEmailCodeUsed(rec.id);
  } catch {
    throw new AuthError(409, '该邮箱已注册');
  }
  return issueSession(id, email);
}

export async function loginUser(email: string, password: string) {
  const user = repo.findUserByEmail(email);
  if (!user || !(await argon2.verify(user.password_hash, password))) throw new AuthError(401, '邮箱或密码错误');
  return issueSession(user.id, user.email);
}

export function logoutSession(sessionId: string) {
  repo.deleteSession(sessionId);
}
