import Busboy from 'busboy';
import { jsonError, type RequestContext, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { changePassword, ProfileError, updateAvatar } from './profile.service.js';

type ParsedAvatarUpload = { file?: { buffer: Buffer; filename: string; mimeType: string } };

function parseAvatarUpload(ctx: RequestContext): Promise<ParsedAvatarUpload> {
  return new Promise((resolve, reject) => {
    const contentType = ctx.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) return reject(Object.assign(new Error('请使用 multipart/form-data 上传'), { status: 400 }));
    const busboy = Busboy({ headers: ctx.req.headers, limits: { files: 1, fileSize: 2 * 1024 * 1024, fields: 2 } });
    let file: ParsedAvatarUpload['file'];
    let fileTooLarge = false;
    busboy.on('file', (name, stream, info) => {
      if (name !== 'avatar') { stream.resume(); return; }
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('limit', () => { fileTooLarge = true; stream.resume(); });
      stream.on('end', () => { file = { buffer: Buffer.concat(chunks), filename: info.filename || 'avatar', mimeType: info.mimeType }; });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => {
      if (fileTooLarge) reject(Object.assign(new Error('头像不能超过 2MB'), { status: 400 }));
      else resolve({ file });
    });
    ctx.req.pipe(busboy);
  });
}

export function registerProfileRoutes(router: Router) {
  router.post('/api/profile/avatar', requireAuth, async (ctx) => {
    try {
      const body = await parseAvatarUpload(ctx);
      if (!body.file) return jsonError(ctx, 400, '请选择头像图片');
      ctx.sendJson(await updateAvatar(auth(ctx).userId, auth(ctx).email, body.file));
    } catch (error) {
      return jsonError(ctx, error instanceof ProfileError ? error.status : ((error as any).status || 400), error instanceof Error ? error.message : '头像上传失败');
    }
  });

  router.post('/api/profile/password', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');
    try { await changePassword(auth(ctx).userId, currentPassword, newPassword, confirmPassword); }
    catch (error) { return jsonError(ctx, error instanceof ProfileError ? error.status : 400, error instanceof Error ? error.message : '密码修改失败'); }
    ctx.sendJson({ ok: true });
  });
}
