import { createReadStream } from 'node:fs';
import { jsonError, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { listWorkspaceFiles, resolveWorkspaceFile } from './workspace.service.js';

export function registerWorkspaceRoutes(router: Router) {
  router.get('/api/conversations/:id/workspace', requireAuth, async (ctx) => {
    const workspace = await listWorkspaceFiles(auth(ctx).userId, ctx.params.id);
    if (!workspace) return jsonError(ctx, 404, '会话不存在');
    ctx.sendJson({ workspace });
  });

  router.get('/api/conversations/:id/workspace/files/:bucket/:name', requireAuth, async (ctx) => {
    const file = await resolveWorkspaceFile(auth(ctx).userId, ctx.params.id, ctx.params.bucket, ctx.params.name);
    if (!file) return jsonError(ctx, 404, '文件不存在');
    const disposition = ctx.url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    ctx.res.writeHead(200, {
      'content-type': file.mimeType,
      'content-length': file.size,
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'cache-control': 'private, max-age=3600'
    });
    createReadStream(file.filePath).on('error', () => {
      if (!ctx.res.writableEnded) ctx.res.end();
    }).pipe(ctx.res);
  });
}
