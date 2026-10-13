import { openStored } from '../../infrastructure/storage/object-store.js';
import { jsonError, type Router } from './http.js';
import { auth, requireAuth } from '../../infrastructure/auth/security.js';
import { findUserAttachment } from '../../infrastructure/uploads/upload.repo.js';

export function registerFileRoutes(router: Router) {
  router.get('/api/files/:attachmentId', requireAuth, async (ctx) => {
    const rec = findUserAttachment(ctx.params.attachmentId, auth(ctx).userId);
    if (!rec) return jsonError(ctx, 404, '文件不存在');
    const opened = await openStored(rec.file_path);
    if (!opened) return jsonError(ctx, 404, '文件不存在');
    const disposition = ctx.url.searchParams.get('download') === '1'
      ? `attachment; filename*=UTF-8''${encodeURIComponent(rec.original_name || 'download')}`
      : 'inline';
    ctx.res.writeHead(200, { 'content-type': rec.mime_type, 'content-length': opened.size, 'content-disposition': disposition, 'cache-control': 'private, max-age=3600' });
    opened.stream.on('error', () => { if (!ctx.res.writableEnded) ctx.res.end(); });
    opened.stream.pipe(ctx.res);
  });

}
