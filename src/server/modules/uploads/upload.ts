import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { jsonError, type RequestContext, type Router } from '../../core/http.js';
import { auth, allowedImageMimes, allowedTableMimes, maxUploadBytes, newId, tableUploadMaxBytes, requireAuth } from '../../core/security.js';
import { uploadDir } from '../../core/db.js';
import { saveImageBuffer, saveImageFile, saveTableFile, uploadImage } from './upload.service.js';

export { saveImageBuffer, saveImageFile };

type ImageUpload = { buffer: Buffer; filename: string; mimeType: string };
type TableUpload = { tempPath: string; filename: string; mimeType: string; size: number };
type ParsedUpload = { image?: ImageUpload; table?: TableUpload; fields: Record<string, string> };

function safeOriginalName(value: string) {
  const name = basename(String(value || '').replace(/[\\/]/g, '/')).replace(/[\0\r\n]/g, '').trim();
  return name.slice(0, 180) || 'upload';
}

function isTableFile(filename: string, mimeType: string) {
  const lower = filename.toLowerCase();
  return (lower.endsWith('.csv') || lower.endsWith('.xlsx')) && allowedTableMimes.has(mimeType);
}

async function parseMultipart(ctx: RequestContext, userId: string): Promise<ParsedUpload> {
  const tempDir = join(uploadDir, userId);
  await mkdir(tempDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const contentType = ctx.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      reject(Object.assign(new Error('请使用 multipart/form-data 上传'), { status: 400 }));
      return;
    }

    const busboy = Busboy({ headers: ctx.req.headers, limits: { files: 1, fileSize: tableUploadMaxBytes, fields: 8 } });
    const fields: Record<string, string> = {};
    const pendingWrites: Promise<void>[] = [];
    let image: ImageUpload | undefined;
    let table: TableUpload | undefined;
    let imageTooLarge = false;
    let tableTooLarge = false;
    let unsupported = false;

    const cleanup = async () => {
      if (table?.tempPath) await unlink(table.tempPath).catch(() => undefined);
    };

    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }
      const filename = safeOriginalName(info.filename);
      const mimeType = String(info.mimeType || '').toLowerCase();
      if (!allowedImageMimes.has(mimeType) && !isTableFile(filename, mimeType)) {
        unsupported = true;
        stream.resume();
        return;
      }

      if (allowedImageMimes.has(mimeType)) {
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (!imageTooLarge && size <= maxUploadBytes) chunks.push(buffer);
          if (size > maxUploadBytes) imageTooLarge = true;
        });
        stream.on('limit', () => { imageTooLarge = true; stream.resume(); });
        stream.on('end', () => {
          if (!imageTooLarge) image = { buffer: Buffer.concat(chunks), filename, mimeType };
        });
        return;
      }

      const tempPath = join(tempDir, `.${newId('upload')}.part`);
      table = { tempPath, filename, mimeType, size: 0 };
      const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
      stream.on('data', chunk => { table!.size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)); });
      stream.on('limit', () => { tableTooLarge = true; stream.resume(); });
      pendingWrites.push(pipeline(stream, output).catch(error => {
        tableTooLarge = true;
        throw error;
      }));
    });
    busboy.on('error', error => { void cleanup().finally(() => reject(error)); });
    busboy.on('finish', () => {
      void Promise.all(pendingWrites).then(async () => {
        if (imageTooLarge) throw Object.assign(new Error(`图片不能超过 ${process.env.MAX_UPLOAD_MB || 5}MB`), { status: 400 });
        if (tableTooLarge || table?.size && table.size > tableUploadMaxBytes) throw Object.assign(new Error('表格文件不能超过 100MB'), { status: 413 });
        if (unsupported) throw Object.assign(new Error('仅支持 jpeg/png/webp 图片或 CSV/XLSX 文件'), { status: 400 });
        resolve({ image, table, fields });
      }).catch(async error => {
        await cleanup();
        reject(error);
      });
    });
    ctx.req.pipe(busboy);
  });
}

export function registerUploadRoutes(router: Router) {
  router.post('/api/upload', requireAuth, async (ctx) => {
    let body: ParsedUpload | undefined;
    try {
      body = await parseMultipart(ctx, auth(ctx).userId);
      const conversationId = body.fields.conversationId || undefined;
      if (body.image) {
        ctx.sendJson({ attachment: await uploadImage(auth(ctx).userId, body.image, conversationId) });
        return;
      }
      if (body.table) {
        ctx.sendJson({ attachment: await saveTableFile(auth(ctx).userId, body.table, conversationId) });
        return;
      }
      return jsonError(ctx, 400, '请上传图片或 CSV/XLSX 文件');
    } catch (e) {
      if (body?.table?.tempPath) await unlink(body.table.tempPath).catch(() => undefined);
      return jsonError(ctx, (e as any).status || 400, e instanceof Error ? e.message : '上传失败');
    }
  });
}
