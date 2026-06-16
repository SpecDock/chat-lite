import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { uploadDir } from '../../core/db.js';
import { allowedImageMimes, maxUploadBytes, newId } from '../../core/security.js';
import * as repo from './upload.repo.js';

export async function saveImageBuffer(userId: string, file: { buffer: Buffer; filename: string; mimeType: string }, conversationId?: string, maxBytes = maxUploadBytes, maxLabel = `${process.env.MAX_UPLOAD_MB || 5}MB`) {
  if (!allowedImageMimes.has(file.mimeType)) throw new Error('仅支持 jpeg/png/webp 图片');
  if (file.buffer.length > maxBytes) throw new Error(`图片不能超过 ${maxLabel}`);
  const ext = file.mimeType === 'image/png' ? '.png' : file.mimeType === 'image/webp' ? '.webp' : (extname(file.filename) || '.jpg');
  const id = newId('att');
  const userDir = join(uploadDir, userId);
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
