import Busboy from 'busboy';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { jsonError, type RequestContext, type Router } from './http.js';
import { allowedImageMimes, auth, maxUploadBytes, requireAuth } from '../../infrastructure/auth/security.js';
import type { ImageFileBytes } from '../../infrastructure/images/image-generation.service.js';
import { failInterruptedRuns } from '../../infrastructure/studio/studio.repo.js';
import { deleteStudioImage, findStudioImageFile, findStudioReferenceFile, listStudioImages, startStudioImage, StudioError } from '../../application/studio/studio.service.js';

const MAX_REFERENCES = 16;

type ParsedStudioRequest = {
  prompt: string;
  aspectRatio: string;
  quality: string;
  style: string;
  images: ImageFileBytes[];
};

function safeFilename(value: string, mimeType: string) {
  const name = basename(String(value || '').replace(/[\\/]/g, '/')).replace(/[\0\r\n]/g, '').trim();
  if (name) return name.slice(0, 180);
  if (mimeType === 'image/png') return 'reference.png';
  if (mimeType === 'image/webp') return 'reference.webp';
  return 'reference.jpg';
}

function readLimitedFile(stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }): Promise<ImageFileBytes> {
  const mimeType = String(info.mimeType || '').toLowerCase();
  if (!allowedImageMimes.has(mimeType)) {
    stream.resume();
    return Promise.reject(Object.assign(new StudioError(400, '参考图仅支持 jpeg/png/webp 图片'), { status: 400 }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxUploadBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    stream.on('limit', () => { tooLarge = true; });
    stream.on('error', reject);
    stream.on('end', () => {
      if (tooLarge) {
        reject(new StudioError(400, `图片不能超过 ${process.env.MAX_UPLOAD_MB || 5}MB`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) {
        reject(new StudioError(400, '参考图无效'));
        return;
      }
      resolve({ buffer, mimeType, filename: safeFilename(info.filename, mimeType) });
    });
  });
}

function parseStudioRequest(ctx: RequestContext): Promise<ParsedStudioRequest> {
  return new Promise((resolve, reject) => {
    const contentType = ctx.header('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      reject(new StudioError(400, '请使用 multipart/form-data 上传'));
      return;
    }
    const busboy = Busboy({
      headers: ctx.req.headers,
      limits: { files: MAX_REFERENCES, fileSize: maxUploadBytes, fields: 8, fieldSize: 32 * 1024 },
    });
    const fields: Record<string, string> = {};
    const images: Array<ImageFileBytes | undefined> = [];
    const tasks: Promise<void>[] = [];
    let tooMany = false;
    let failed = false;

    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      reject(error instanceof StudioError ? error : new StudioError(400, error instanceof Error ? error.message : '上传失败'));
    };

    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('filesLimit', () => { tooMany = true; });
    busboy.on('file', (name, stream, info) => {
      if (name !== 'images') {
        stream.resume();
        fail(new StudioError(400, '参考图请使用 images 字段上传'));
        return;
      }
      const index = images.length;
      images.push(undefined);
      tasks.push(readLimitedFile(stream, info).then(image => { images[index] = image; }).catch(fail));
    });
    busboy.on('error', fail);
    busboy.on('finish', () => {
      void Promise.all(tasks).then(() => {
        if (failed) return;
        if (tooMany) {
          fail(new StudioError(400, '参考图最多 16 张'));
          return;
        }
        resolve({
          prompt: fields.prompt || '',
          aspectRatio: String(fields.aspectRatio || '').trim(),
          quality: String(fields.quality || '').trim(),
          style: String(fields.style || 'vivid').trim(),
          images: images.filter((image): image is ImageFileBytes => Boolean(image)),
        });
      }).catch(fail);
    });
    ctx.req.pipe(busboy);
  });
}

function studioStatus(error: unknown) {
  if (error instanceof StudioError) return error.status;
  const status = (error as { status?: number }).status;
  return status || 400;
}

export function registerStudioRoutes(router: Router) {
  const interrupted = failInterruptedRuns();
  if (interrupted > 0) console.log(`[studio] marked ${interrupted} interrupted image jobs as failed`);

  router.post('/api/studio/images', requireAuth, async (ctx) => {
    try {
      const body = await parseStudioRequest(ctx);
      const image = await startStudioImage({
        userId: auth(ctx).userId,
        prompt: body.prompt,
        aspectRatio: body.aspectRatio,
        quality: body.quality,
        style: body.style,
        images: body.images,
      });
      ctx.sendJson({ image });
    } catch (error) {
      if (error instanceof StudioError) return jsonError(ctx, error.status, error.message);
      console.error('[studio] create image failed', error instanceof Error ? error.message : error);
      return jsonError(ctx, studioStatus(error), '图片生成失败');
    }
  });

  router.get('/api/studio/images', requireAuth, (ctx) => {
    ctx.sendJson({ images: listStudioImages(auth(ctx).userId) });
  });

  router.delete('/api/studio/images/:id', requireAuth, async (ctx) => {
    try {
      await deleteStudioImage(ctx.params.id, auth(ctx).userId);
      ctx.sendJson({ ok: true });
    } catch (error) {
      if (error instanceof StudioError) return jsonError(ctx, error.status, error.message);
      console.error('[studio] delete image failed', error instanceof Error ? error.message : error);
      return jsonError(ctx, 500, '删除失败');
    }
  });

  router.get('/api/studio/images/:id/references/:refId', requireAuth, async (ctx) => {
    const row = findStudioReferenceFile(ctx.params.id, ctx.params.refId, auth(ctx).userId);
    if (!row) return jsonError(ctx, 404, '文件不存在');
    const buf = await readFile(row.file_path).catch(() => undefined);
    if (!buf) return jsonError(ctx, 404, '文件不存在');
    ctx.res.writeHead(200, {
      'content-type': row.mime_type || 'application/octet-stream',
      'content-length': buf.length,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=3600',
    });
    ctx.res.end(buf);
  });

  router.get('/api/studio/images/:id/file', requireAuth, async (ctx) => {
    const row = findStudioImageFile(ctx.params.id, auth(ctx).userId);
    if (!row?.file_path) return jsonError(ctx, 404, '文件不存在');
    const buf = await readFile(row.file_path).catch(() => undefined);
    if (!buf) return jsonError(ctx, 404, '文件不存在');
    ctx.res.writeHead(200, {
      'content-type': row.mime_type || 'application/octet-stream',
      'content-length': buf.length,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=3600',
    });
    ctx.res.end(buf);
  });
}
