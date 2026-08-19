import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { uploadDir } from '../../core/db.js';
import { allowedImageMimes, allowedTableMimes, maxUploadBytes, newId, tableUploadMaxBytes } from '../../core/security.js';
import type { WorkspaceBucket } from '../../../shared/types.js';
import { conversationInputDir, conversationOutputDir, ensureConversationWorkspace } from '../workspace/workspace.service.js';
import * as repo from './upload.repo.js';

export async function saveImageBuffer(userId: string, file: { buffer: Buffer; filename: string; mimeType: string }, conversationId?: string, maxBytes = maxUploadBytes, maxLabel = `${process.env.MAX_UPLOAD_MB || 5}MB`, bucket: WorkspaceBucket = 'input') {
  if (!allowedImageMimes.has(file.mimeType)) throw new Error('仅支持 jpeg/png/webp 图片');
  if (file.buffer.length > maxBytes) throw new Error(`图片不能超过 ${maxLabel}`);
  const ext = file.mimeType === 'image/png' ? '.png' : file.mimeType === 'image/webp' ? '.webp' : (extname(file.filename) || '.jpg');
  const id = newId('att');
  const userDir = conversationId
    ? (ensureConversationWorkspace(conversationId), bucket === 'output' ? conversationOutputDir(conversationId) : conversationInputDir(conversationId))
    : join(uploadDir, userId);
  await mkdir(userDir, { recursive: true });
  const filePath = join(userDir, `${id}${ext}`);
  await writeFile(filePath, file.buffer);
  const publicPath = `/api/files/${id}`;
  const createdAt = repo.insertAttachment({ id, userId, conversationId, originalName: file.filename, filePath, publicPath, mimeType: file.mimeType, size: file.buffer.length });
  return { id, original_name: file.filename, public_path: publicPath, mime_type: file.mimeType, size: file.buffer.length, created_at: createdAt };
}

export const saveImageFile = saveImageBuffer;

export async function uploadImage(userId: string, file: { buffer: Buffer; filename: string; mimeType: string }, conversationId?: string) {
  if (conversationId && !repo.userConversationExists(conversationId, userId)) {
    const error = new Error('会话不存在') as Error & { status: number };
    error.status = 404;
    throw error;
  }
  return saveImageBuffer(userId, file, conversationId);
}

function isTableFile(filename: string, mimeType: string) {
  const extension = extname(filename).toLowerCase();
  return (extension === '.csv' || extension === '.xlsx') && allowedTableMimes.has(mimeType);
}

export async function saveTableFile(userId: string, file: { tempPath: string; filename: string; mimeType: string; size: number }, conversationId?: string) {
  if (!conversationId || !repo.userConversationExists(conversationId, userId)) {
    throw Object.assign(new Error('会话不存在'), { status: 404 });
  }
  if (!isTableFile(file.filename, file.mimeType)) throw new Error('仅支持 CSV 或 XLSX 文件');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > tableUploadMaxBytes) {
    throw new Error('表格文件不能超过 100MB');
  }
  const actual = await stat(file.tempPath).catch(() => undefined);
  if (!actual?.isFile() || actual.size !== file.size || actual.size > tableUploadMaxBytes) {
    throw new Error('上传文件校验失败');
  }

  const id = newId('att');
  const extension = extname(file.filename).toLowerCase() === '.xlsx' ? '.xlsx' : '.csv';
  const directory = (ensureConversationWorkspace(conversationId), conversationInputDir(conversationId));
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${id}${extension}`);
  try {
    await rename(file.tempPath, filePath);
    const publicPath = `/api/files/${id}`;
    const createdAt = repo.insertAttachment({
      id,
      userId,
      conversationId,
      originalName: file.filename,
      filePath,
      publicPath,
      mimeType: file.mimeType,
      size: file.size,
    });
    return { id, original_name: file.filename, public_path: publicPath, mime_type: file.mimeType, size: file.size, created_at: createdAt };
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}
