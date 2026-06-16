import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { jsonError, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { findAttachment, findUserAttachment } from './upload.repo.js';

function sourceSecret() {
  return process.env.FILE_SOURCE_SECRET || process.env.SESSION_SECRET || process.env.INVITE_CODE || 'chat-lite-file-source';
}

function signSource(attachmentId: string, expiresAt: number) {
  return createHmac('sha256', sourceSecret()).update(`${attachmentId}.${expiresAt}`).digest('base64url');
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createSignedImageSourceUrl(attachmentId: string, ttlMs = 5 * 60_000) {
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, '');
  if (!origin) throw new Error('生成图生图源图 URL 需要设置 APP_ORIGIN');
  const exp = Date.now() + ttlMs;
  const sig = signSource(attachmentId, exp);
  return `${origin}/api/image-source/${encodeURIComponent(attachmentId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

export function registerFileRoutes(router: Router) {
  router.get('/api/files/:attachmentId', requireAuth, async (ctx) => {
    const rec = findUserAttachment(ctx.params.attachmentId, auth(ctx).userId);
    if (!rec) return jsonError(ctx, 404, '文件不存在');
    const buf = await readFile(rec.file_path).catch(() => undefined);
    if (!buf) return jsonError(ctx, 404, '文件不存在');
    ctx.res.writeHead(200, { 'content-type': rec.mime_type, 'cache-control': 'private, max-age=3600' });
    ctx.res.end(buf);
  });

  router.get('/api/image-source/:attachmentId', async (ctx) => {
    const attachmentId = ctx.params.attachmentId;
    const exp = Number(ctx.url.searchParams.get('exp') || 0);
    const sig = ctx.url.searchParams.get('sig') || '';
    if (!attachmentId || !exp || exp < Date.now() || !sig || !safeEqual(sig, signSource(attachmentId, exp))) {
      return jsonError(ctx, 403, '图片链接无效或已过期');
    }
    const rec = findAttachment(attachmentId);
    if (!rec) return jsonError(ctx, 404, '文件不存在');
    const buf = await readFile(rec.file_path).catch(() => undefined);
    if (!buf) return jsonError(ctx, 404, '文件不存在');
    ctx.res.writeHead(200, { 'content-type': rec.mime_type, 'cache-control': 'private, max-age=300' });
    ctx.res.end(buf);
  });
}
