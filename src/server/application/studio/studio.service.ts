import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../../infrastructure/db/db.js';
import { isWithinDirectory } from '../../infrastructure/files/workspace-paths.js';
import { newId } from '../../infrastructure/auth/security.js';
import { generateEditedImageBytes, generateTextImageBytes, type ImageFileBytes } from '../../infrastructure/images/image-generation.service.js';
import { readGeneratedImage } from '../../domain/studio/image-dimensions.js';
import * as repo from '../../infrastructure/studio/studio.repo.js';
import type { StudioImageRow } from '../../infrastructure/studio/studio.repo.js';

export const STUDIO_ASPECT_SIZES = {
  auto: undefined,
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '2048x1536',
  '3:4': '1536x2048',
  '16:9': '2048x1152',
  '9:16': '1152x2048',
  '21:9': '3360x1440',
} as const;

export const STUDIO_QUALITIES = ['auto', 'low', 'medium', 'standard', 'high', 'xhigh', 'max'] as const;
export const STUDIO_STYLES = ['vivid', 'natural'] as const;

const MAX_REFERENCES = 16;
const MAX_PROMPT_LENGTH = 4000;
const USER_ID_RE = /^user_[A-Za-z0-9_-]+$/;

export type StudioAspectRatio = keyof typeof STUDIO_ASPECT_SIZES;
export type StudioQuality = (typeof STUDIO_QUALITIES)[number];
export type StudioStyle = (typeof STUDIO_STYLES)[number];

export class StudioError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type StudioImageDto = {
  id: string;
  user_id: string;
  prompt: string;
  aspect_ratio: string;
  quality: string;
  style: string;
  width: number | null;
  height: number | null;
  status: StudioImageRow['status'];
  error: string | null;
  duration_ms: number | null;
  mime_type: string | null;
  created_at: string;
  file_url: string | null;
  references: { id: string; url: string }[];
};

function isAspectRatio(value: string): value is StudioAspectRatio {
  return Object.prototype.hasOwnProperty.call(STUDIO_ASPECT_SIZES, value);
}

function isQuality(value: string): value is StudioQuality {
  return (STUDIO_QUALITIES as readonly string[]).includes(value);
}

function isStyle(value: string): value is StudioStyle {
  return (STUDIO_STYLES as readonly string[]).includes(value);
}

function referenceUrl(imageId: string, referenceId: string) {
  return `/api/studio/images/${imageId}/references/${referenceId}`;
}

export function toStudioImageDto(row: StudioImageRow, references: repo.StudioReferenceRow[] = []): StudioImageDto {
  return {
    id: row.id,
    user_id: row.user_id,
    prompt: row.prompt,
    aspect_ratio: row.aspect_ratio,
    quality: row.quality,
    style: row.style || 'vivid',
    width: row.width,
    height: row.height,
    status: row.status,
    error: row.error,
    duration_ms: row.duration_ms,
    mime_type: row.mime_type,
    created_at: row.created_at,
    file_url: row.status === 'succeeded' && row.file_path ? `/api/studio/images/${row.id}/file` : null,
    references: references.map(item => ({ id: item.id, url: referenceUrl(row.id, item.id) })),
  };
}

function studioUserDir(userId: string) {
  if (!USER_ID_RE.test(userId)) throw new StudioError(400, '无效用户');
  return join(dataDir, 'studio', userId);
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : '图片生成失败';
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || '图片生成失败';
}

async function removeStudioFile(userId: string, filePath: string | null | undefined) {
  if (!filePath) return;
  const directory = studioUserDir(userId);
  if (!isWithinDirectory(directory, filePath)) {
    console.error('[studio] refused to delete file outside studio directory', { userId });
    return;
  }
  await unlink(filePath).catch(error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  });
}

export function assertStudioRequest(input: { prompt: string; aspectRatio: string; quality: string; style: string; imageCount: number }) {
  const prompt = input.prompt.trim();
  if (!prompt) throw new StudioError(400, '提示词不能为空');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new StudioError(400, `提示词不能超过 ${MAX_PROMPT_LENGTH} 字`);
  if (!isAspectRatio(input.aspectRatio)) throw new StudioError(400, '不支持的画面比例');
  if (!isQuality(input.quality)) throw new StudioError(400, '不支持的画质');
  if (!isStyle(input.style)) throw new StudioError(400, '不支持的画面风格');
  if (input.imageCount > MAX_REFERENCES) throw new StudioError(400, '参考图最多 16 张');
  return { prompt, aspectRatio: input.aspectRatio, quality: input.quality, style: input.style };
}

export async function startStudioImage(input: {
  userId: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  style: string;
  images: ImageFileBytes[];
}) {
  const request = assertStudioRequest({
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    quality: input.quality,
    style: input.style,
    imageCount: input.images.length,
  });
  const images = input.images.map(image => {
    const measured = readGeneratedImage(image.buffer);
    if (!measured) throw new StudioError(400, '参考图仅支持 jpeg/png/webp 图片');
    return { buffer: image.buffer, mimeType: measured.mimeType, filename: image.filename };
  });
  const row = repo.insertRunning({
    id: newId('simg'),
    userId: input.userId,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    style: request.style,
  });
  if (!row) throw new StudioError(409, '当前已有 4 张图片正在生成，请等完成后再试。');
  let references: repo.StudioReferenceRow[] = [];
  try {
    references = await saveReferences(row, images);
  } catch (error) {
    repo.deleteOwned(row.id, row.user_id);
    throw error;
  }
  const startedAt = Date.now();
  void runStudioImage(row, images, request.aspectRatio, request.quality, startedAt).catch(error => {
    console.error('[studio] image generation crashed', row.id, error instanceof Error ? error.message : error);
  });
  return toStudioImageDto(row, references);
}

async function saveReferences(row: StudioImageRow, images: ImageFileBytes[]) {
  if (!images.length) return [];
  const root = studioUserDir(row.user_id);
  const directory = join(root, 'refs');
  await mkdir(directory, { recursive: true });
  const rows: repo.StudioReferenceRow[] = [];
  const written: string[] = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const measured = readGeneratedImage(image.buffer);
      if (!measured) throw new StudioError(400, '参考图仅支持 jpeg/png/webp 图片');
      const id = newId('sref');
      const filePath = join(directory, `${id}${measured.ext}`);
      if (!isWithinDirectory(root, filePath)) throw new StudioError(400, '参考图路径无效');
      await writeFile(filePath, image.buffer);
      written.push(filePath);
      rows.push({
        id,
        studio_image_id: row.id,
        user_id: row.user_id,
        file_path: filePath,
        mime_type: measured.mimeType,
        sort_order: index,
      });
    }
    repo.insertReferences(rows);
    return rows;
  } catch (error) {
    await Promise.all(written.map(path => removeStudioFile(row.user_id, path).catch(() => undefined)));
    throw error;
  }
}

async function runStudioImage(row: StudioImageRow, images: ImageFileBytes[], aspectRatio: StudioAspectRatio, quality: StudioQuality, startedAt: number) {
  let filePath: string | undefined;
  try {
    const size = STUDIO_ASPECT_SIZES[aspectRatio];
    const options = { ...(size ? { size } : {}), quality, style: row.style || 'vivid' };
    const image = images.length
      ? await generateEditedImageBytes(row.prompt, images, options)
      : await generateTextImageBytes(row.prompt, options);
    const measured = readGeneratedImage(image.buffer);
    if (!measured) throw new Error('无法读取生成图片尺寸');
    const directory = studioUserDir(row.user_id);
    await mkdir(directory, { recursive: true });
    filePath = join(directory, `${row.id}${measured.ext}`);
    if (!isWithinDirectory(directory, filePath)) throw new Error('生成图片路径无效');
    await writeFile(filePath, image.buffer);
    const saved = repo.markSucceeded({
      id: row.id,
      userId: row.user_id,
      width: measured.width,
      height: measured.height,
      durationMs: Date.now() - startedAt,
      filePath,
      mimeType: measured.mimeType,
    });
    if (!saved) await removeStudioFile(row.user_id, filePath);
  } catch (error) {
    const message = errorText(error);
    console.error('[studio] image generation failed', row.id, message);
    let updated = false;
    try {
      updated = repo.markFailed(row.id, row.user_id, message, Date.now() - startedAt);
    } catch (updateError) {
      console.error('[studio] failed to record image error', row.id, updateError instanceof Error ? updateError.message : updateError);
    }
    if (!updated) {
      if (filePath) await removeStudioFile(row.user_id, filePath);
      return;
    }
    if (filePath) await removeStudioFile(row.user_id, filePath);
  }
}

export function listStudioImages(userId: string) {
  const grouped = new Map<string, repo.StudioReferenceRow[]>();
  for (const reference of repo.listReferencesByUser(userId)) {
    const list = grouped.get(reference.studio_image_id) ?? [];
    list.push(reference);
    grouped.set(reference.studio_image_id, list);
  }
  return repo.listByUser(userId).map(row => toStudioImageDto(row, grouped.get(row.id) ?? []));
}

export async function deleteStudioImage(id: string, userId: string) {
  const references = repo.listReferences(id, userId);
  const row = repo.deleteOwned(id, userId);
  if (!row) throw new StudioError(404, '记录不存在');
  try {
    await removeStudioFile(userId, row.file_path);
    for (const reference of references) await removeStudioFile(userId, reference.file_path);
  } catch (error) {
    console.error('[studio] failed to delete image file', row.id, error instanceof Error ? error.message : error);
    throw new StudioError(500, '图片文件删除失败');
  }
}

export function findStudioReferenceFile(imageId: string, referenceId: string, userId: string) {
  const row = repo.findReference(imageId, referenceId, userId);
  if (!row) return undefined;
  const directory = studioUserDir(userId);
  if (!isWithinDirectory(directory, row.file_path)) return undefined;
  return row;
}

export function findStudioImageFile(id: string, userId: string) {
  const row = repo.findOwned(id, userId);
  if (!row || row.status !== 'succeeded' || !row.file_path) return undefined;
  const directory = studioUserDir(userId);
  if (!isWithinDirectory(directory, row.file_path)) return undefined;
  return row;
}
