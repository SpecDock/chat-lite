import Busboy from 'busboy';
import { jsonError, type RequestContext, type Router } from '../../core/http.js';
import { auth, maxUploadBytes, requireAuth } from '../../core/security.js';
import { saveImageBuffer, saveImageFile, uploadImage } from './upload.service.js';

export { saveImageBuffer, saveImageFile };

type ParsedUpload = { file?: { buffer: Buffer; filename: string; mimeType: string }; fields: Record<string, string> };

function parseMultipart(ctx: RequestContext): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const contentType = ctx.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) return reject(Object.assign(new Error('请使用 multipart/form-data 上传'), { status: 400 }));
    const busboy = Busboy({ headers: ctx.req.headers, limits: { files: 1, fileSize: maxUploadBytes, fields: 8 } });
    const fields: Record<string, string> = {};
    let file: ParsedUpload['file'];
    let fileTooLarge = false;
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const chunks: Buffer[] = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('limit', () => { fileTooLarge = true; stream.resume(); });
      stream.on('end', () => { file = { buffer: Buffer.concat(chunks), filename: info.filename || 'upload', mimeType: info.mimeType }; });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => {
      if (fileTooLarge) reject(Object.assign(new Error(`图片不能超过 ${process.env.MAX_UPLOAD_MB || 5}MB`), { status: 400 }));
      else resolve({ file, fields });
    });
    ctx.req.pipe(busboy);
  });
}

export function registerUploadRoutes(router: Router) {
  router.post('/api/upload', requireAuth, async (ctx) => {
    try {
      const body = await parseMultipart(ctx);
      const conversationId = body.fields.conversationId || undefined;
      if (!body.file) return jsonError(ctx, 400, '请上传图片文件');
      ctx.sendJson({ attachment: await uploadImage(auth(ctx).userId, body.file, conversationId) });
    } catch (e) {
      return jsonError(ctx, (e as any).status || 400, e instanceof Error ? e.message : '上传失败');
    }
  });
}
