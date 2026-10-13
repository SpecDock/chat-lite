import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, row } from '../db/db.js';
import { jsonError, parseCookies, type Handler, type Middleware, type RequestContext } from '../../interfaces/http/http.js';

export type Authed = { userId: string; email: string; sessionId: string };

export const cookieName = process.env.SESSION_COOKIE_NAME || 'chat_lite_session';
export const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 5) * 1024 * 1024;
export const allowedImageMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const tableUploadMaxBytes = 100 * 1024 * 1024;
export const allowedTableMimes = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function newId(prefix: string) {
  return `${prefix}_${nanoid(24)}`;
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

const buckets = new Map<string, { count: number; reset: number }>();
const emailCodeBuckets = new Map<string, number>();

export function clientIp(ctx: RequestContext) {
  return ctx.header('x-forwarded-for')?.split(',')[0]?.trim() || ctx.req.socket.remoteAddress || 'local';
}

export function reserveEmailCodeRateLimit(email: string, ip: string, windowMs = 60_000) {
  const time = Date.now();
  for (const [key, reset] of emailCodeBuckets) {
    if (reset <= time) emailCodeBuckets.delete(key);
  }

  const keys = [`email:${email}`, `ip:${ip}`];
  if (keys.some(key => (emailCodeBuckets.get(key) || 0) > time)) return false;
  for (const key of keys) emailCodeBuckets.set(key, time + windowMs);
  return true;
}

export function rateLimit(max = 30, windowMs = 60_000): Middleware {
  return async (ctx, next) => {
    const ip = clientIp(ctx);
    const key = `${ip}:${ctx.path}`;
    const current = buckets.get(key);
    const time = Date.now();
    if (!current || current.reset < time) buckets.set(key, { count: 1, reset: time + windowMs });
    else if (++current.count > max) return jsonError(ctx, 429, '请求过于频繁，请稍后再试');
    await next?.();
  };
}

export const requireAuth: Handler = async (ctx: RequestContext) => {
  const token = parseCookies(ctx.header('cookie') || '')[cookieName];
  if (!token) return jsonError(ctx, 401, '未登录');
  const session = row<{ id: string; user_id: string; email: string; expires_at: string }>(
    `SELECT sessions.id, sessions.user_id, sessions.expires_at, users.email
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`, sha256(token)
  );
  if (!session || Date.parse(session.expires_at) < Date.now()) {
    if (session) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return jsonError(ctx, 401, '登录已过期');
  }
  ctx.set('auth', { userId: session.user_id, email: session.email, sessionId: session.id } satisfies Authed);
};

export function auth(ctx: RequestContext): Authed {
  return ctx.get<Authed>('auth');
}

export async function withAuth(ctx: RequestContext, fn: Handler) {
  await requireAuth(ctx);
  if (!ctx.res.writableEnded) await fn(ctx);
}

export function safeTitle(text: string) {
  return text.trim().replace(/\s+/g, ' ').slice(0, 40) || '新会话';
}
