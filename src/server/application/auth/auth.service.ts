import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { cookieName, newId, newToken, reserveEmailCodeRateLimit, sha256 } from '../../infrastructure/auth/security.js';
import { sendEmailCode } from '../../infrastructure/auth/mail.js';
import * as repo from '../../infrastructure/auth/auth.repo.js';

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeEmail = (v: unknown) => String(v || '').trim().toLowerCase();
export const emailCodeHash = (email: string, code: string) => sha256(`${email}:${code}`);
const passwordCaptchaTtlMs = 5 * 60_000;
const passwordCodeTtlMs = 10 * 60_000;
const maxPasswordCodeAttempts = 3;

type PasswordCaptcha = { answerHash: string; expiresAt: number };
const passwordCaptchas = new Map<string, PasswordCaptcha>();

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

function prunePasswordCaptchas() {
  const time = Date.now();
  for (const [challengeId, challenge] of passwordCaptchas) {
    if (challenge.expiresAt <= time) passwordCaptchas.delete(challengeId);
  }
}

export function createPasswordCaptcha() {
  prunePasswordCaptchas();
  const operator = randomInt(0, 2) === 0 ? '+' : '-';
  let left: number;
  let right: number;
  let answer: number;

  if (operator === '+') {
    left = randomInt(10, 90);
    right = randomInt(10, 100 - left);
    answer = left + right;
  } else {
    left = randomInt(10, 100);
    right = randomInt(10, left + 1);
    answer = left - right;
  }

  const challengeId = newId('captcha');
  passwordCaptchas.set(challengeId, { answerHash: sha256(String(answer)), expiresAt: Date.now() + passwordCaptchaTtlMs });
  return { challengeId, expression: `${left} ${operator} ${right}` };
}

function captchaAnswerHash(value: unknown) {
  const answer = String(value ?? '').trim();
  if (!/^\d+$/.test(answer)) return undefined;
  const number = Number(answer);
  if (!Number.isInteger(number) || number < 0 || number > 99) return undefined;
  return sha256(String(number));
}

function assertPasswordCaptcha(challengeId: string, answer: unknown) {
  const challenge = passwordCaptchas.get(challengeId);
  passwordCaptchas.delete(challengeId);
  if (!challenge || challenge.expiresAt <= Date.now() || captchaAnswerHash(answer) !== challenge.answerHash) {
    throw new AuthError(400, '算术验证码无效或已过期');
  }
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

function createEmailCode() {
  return String(randomInt(100000, 1_000_000));
}

function assertNewPassword(newPassword: string, confirmPassword: string) {
  if (newPassword.length < 8) throw new AuthError(400, '新密码至少 8 位');
  if (newPassword !== confirmPassword) throw new AuthError(400, '两次新密码不一致');
}

function verifyPasswordCode(email: string, purpose: string, code: string) {
  const rec = repo.findLatestEmailCode(email, purpose);
  if (!rec || rec.used_at || Date.parse(rec.expires_at) <= Date.now()) throw new AuthError(400, '验证码无效或已过期');
  if (rec.attempts >= maxPasswordCodeAttempts) throw new AuthError(400, '验证码尝试次数过多');
  repo.incrementEmailCodeAttempts(rec.id);
  if (rec.code_hash !== emailCodeHash(email, code)) throw new AuthError(400, '验证码错误');
  return rec;
}

export async function sendRegisterCode(email: string, inviteCode: string) {
  assertEmail(email);
  assertInvite(inviteCode);
  const code = createEmailCode();
  try {
    await sendEmailCode(email, code, 'register');
  } catch (error) {
    throw new AuthError(502, error instanceof Error ? error.message : '邮件发送失败');
  }
  repo.insertEmailCode(newId('code'), email, emailCodeHash(email, code), 'register', new Date(Date.now() + passwordCodeTtlMs).toISOString());
}

export async function sendPasswordResetCode(email: string, challengeId: string, captchaAnswer: unknown, ip: string) {
  assertEmail(email);
  assertPasswordCaptcha(challengeId, captchaAnswer);
  if (!repo.findUserByEmail(email)) throw new AuthError(404, '该邮箱未注册');
  if (!reserveEmailCodeRateLimit(email, ip)) throw new AuthError(429, '请求过于频繁，请稍后再试');

  const code = createEmailCode();
  try {
    await sendEmailCode(email, code, 'password_reset');
  } catch (error) {
    throw new AuthError(502, error instanceof Error ? error.message : '邮件发送失败');
  }
  repo.insertEmailCode(newId('code'), email, emailCodeHash(email, code), 'password_reset', new Date(Date.now() + passwordCodeTtlMs).toISOString());
}

export async function resetPassword(email: string, code: string, newPassword: string, confirmPassword: string) {
  assertEmail(email);
  assertNewPassword(newPassword, confirmPassword);
  const user = repo.findUserByEmail(email);
  if (!user) throw new AuthError(404, '该邮箱未注册');

  const rec = verifyPasswordCode(email, 'password_reset', code);
  repo.updateUserPasswordHash(user.id, await argon2.hash(newPassword, { type: argon2.argon2id }));
  repo.deleteUserSessions(user.id);
  repo.markEmailCodeUsed(rec.id);
  return { ok: true };
}

export async function registerUser(email: string, password: string, code: string, inviteCode: string) {
  assertEmail(email);
  if (password.length < 8) throw new AuthError(400, '密码至少 8 位');
  assertInvite(inviteCode);
  const rec = repo.findLatestRegisterCode(email);
  if (!rec || rec.used_at || Date.parse(rec.expires_at) < Date.now()) throw new AuthError(400, '验证码无效或已过期');
  if (rec.attempts >= 5) throw new AuthError(400, '验证码尝试次数过多');
  repo.incrementEmailCodeAttempts(rec.id);
  if (rec.code_hash !== emailCodeHash(email, code)) throw new AuthError(400, '验证码错误');
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
