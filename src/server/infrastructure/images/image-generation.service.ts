import { readFile } from 'node:fs/promises';
import { newId } from '../auth/security.js';
import { userConversationExists } from '../uploads/upload.repo.js';
import { saveImageBuffer } from '../../application/uploads/upload.service.js';
import { recordImageUsage } from '../../application/usage/usage.service.js';
import * as repo from './image.repo.js';

type GenerateImageInput = {
  userId: string;
  prompt: string;
  conversationId?: string;
  sourceAttachmentId?: string;
  referenceAttachmentIds?: string[];
  signal?: AbortSignal;
};

export type ImageFileBytes = { buffer: Buffer; mimeType: string; filename: string };

export type ImageApiOptions = {
  size?: string;
  quality?: string;
  style?: string;
  signal?: AbortSignal;
};

const IMAGE_RESPONSE_FORMAT = 'b64_json';

function assertHttpUrl(url: string, name: string) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${name} 必须是完整的 http(s) 地址，当前为：${url || '(空)'}`);
  }
  return url;
}

function normalizeAttachmentId(value: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://chat-lite.local');
    const match = url.pathname.match(/\/api\/files\/([^/?#]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {}
  const match = raw.match(/\/api\/files\/([^/?#\s]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : raw;
}

function textImageApiKey() {
  return process.env.TEXT_IMAGE_API_KEY || '';
}

function editImageApiKey() {
  return process.env.IMAGE_EDIT_API_KEY || '';
}

function imageApiEndpoint() {
  const base = process.env.TEXT_IMAGE_API_URL || '';
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  return /\/images\/generations$/.test(trimmed) ? trimmed : `${trimmed}/images/generations`;
}

function imageEditApiEndpoint() {
  const base = process.env.IMAGE_EDIT_API_URL || '';
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  if (/\/images\/edits$/i.test(trimmed)) return trimmed;
  if (/\/images\/generations$/i.test(trimmed)) return trimmed.replace(/\/images\/generations$/i, '/images/edits');
  return `${trimmed}/images/edits`;
}

function textImageModel() {
  return process.env.TEXT_IMAGE_MODEL || '';
}

function editImageModel() {
  return process.env.IMAGE_EDIT_MODEL || '';
}

function mimeFromUrl(url: string) {
  const clean = url.split('?')[0]?.toLowerCase() || '';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function parseImageApiJson(text: string, res: Response, label: string): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const contentType = res.headers.get('content-type') || 'unknown content-type';
    const ray = res.headers.get('cf-ray');
    const summary = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`${label}返回非 JSON 响应 HTTP ${res.status} (${contentType})${ray ? `，cf-ray=${ray}` : ''}${summary ? `：${summary}` : ''}`);
  }
}

async function postImageGeneration(endpoint: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch(assertHttpUrl(endpoint, 'IMAGE_API_URL'), {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  const text = await res.text();
  const data = parseImageApiJson(text, res, '文生图 API');
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `图片生成失败 HTTP ${res.status}`);
  return data;
}

async function imageFromApiPayload(data: any, label = '图片生成'): Promise<ImageFileBytes> {
  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  const b64 = first?.b64_json || first?.base64 || first?.image_base64;
  const url = first?.url || first?.image_url;

  if (b64) return { buffer: Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64'), mimeType: 'image/png', filename: 'generated.png' };
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载生成图片失败 HTTP ${res.status}`);
    const mimeType = res.headers.get('content-type')?.split(';')[0] || mimeFromUrl(url);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType, filename: `generated.${mimeType.split('/')[1] || 'png'}` };
  }

  throw new Error(`${label} API 未返回 url 或 b64_json`);
}

async function callImageApi(prompt: string, options: ImageApiOptions = {}) {
  const endpoint = imageApiEndpoint();
  const apiKey = textImageApiKey();
  const model = textImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('文生图 API 未配置：请设置 TEXT_IMAGE_API_URL、TEXT_IMAGE_API_KEY、TEXT_IMAGE_MODEL');

  const baseBody: Record<string, unknown> = { model, prompt, n: 1 };
  if (options.size) baseBody.size = options.size;
  if (options.quality) baseBody.quality = options.quality;
  if (options.style) baseBody.style = options.style;
  let data: any;
  try {
    data = await postImageGeneration(endpoint, apiKey, { ...baseBody, response_format: IMAGE_RESPONSE_FORMAT }, options.signal);
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!/response_format|unsupported|invalid|upstream did not return image output/i.test(msg)) throw error;
    data = await postImageGeneration(endpoint, apiKey, baseBody, options.signal);
  }
  return imageFromApiPayload(data);
}

function appendEditImages(form: FormData, sources: ImageFileBytes[]) {
  const field = sources.length > 1 ? 'image[]' : 'image';
  for (const source of sources) {
    form.append(field, new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }), source.filename || 'source.png');
  }
}

async function callImageEditApi(prompt: string, sources: ImageFileBytes[], options: ImageApiOptions = {}) {
  const endpoint = imageEditApiEndpoint();
  const apiKey = editImageApiKey();
  const model = editImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('图生图 API 未配置：请设置 IMAGE_EDIT_API_URL、IMAGE_EDIT_API_KEY、IMAGE_EDIT_MODEL');
  if (!sources.length) throw new Error('图生图至少需要一张主图');

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  if (options.size) form.append('size', options.size);
  form.append('response_format', IMAGE_RESPONSE_FORMAT);
  if (options.quality) form.append('quality', options.quality);
  if (options.style) form.append('style', options.style);
  appendEditImages(form, sources);

  let res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: options.signal
  });
  let text = await res.text();
  let data = parseImageApiJson(text, res, '图生图 API');
  if (!res.ok && /response_format|unsupported|invalid|upstream did not return image output/i.test(data?.error?.message || data?.message || '')) {
    const fallbackForm = new FormData();
    fallbackForm.append('model', model);
    fallbackForm.append('prompt', prompt);
    fallbackForm.append('n', '1');
    if (options.size) fallbackForm.append('size', options.size);
    if (options.quality) fallbackForm.append('quality', options.quality);
    if (options.style) fallbackForm.append('style', options.style);
    appendEditImages(fallbackForm, sources);
    res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: fallbackForm,
      signal: options.signal
    });
    text = await res.text();
    data = parseImageApiJson(text, res, '图生图 API');
  }
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `图生图失败 HTTP ${res.status}`);
  return imageFromApiPayload(data, '图生图');
}

export function generateTextImageBytes(prompt: string, options?: ImageApiOptions) {
  return callImageApi(prompt, options);
}

export function generateEditedImageBytes(prompt: string, sources: ImageFileBytes[], options?: ImageApiOptions) {
  return callImageEditApi(prompt, sources, options);
}

async function loadSourceImage(userId: string, attachmentId: string, conversationId?: string): Promise<ImageFileBytes> {
  const normalizedAttachmentId = normalizeAttachmentId(attachmentId);
  if (!conversationId) throw Object.assign(new Error('图像操作必须指定会话'), { status: 400 });
  const att = repo.findUserAttachmentPath(normalizedAttachmentId, userId, conversationId);
  if (!att) throw Object.assign(new Error(`图片不存在：${normalizedAttachmentId || attachmentId}`), { status: 404 });
  return {
    buffer: await readFile(att.file_path),
    mimeType: att.mime_type || 'image/png',
    filename: att.original_name || 'source.png'
  };
}

export async function generateImageForUser({ userId, prompt, conversationId, sourceAttachmentId, referenceAttachmentIds, signal }: GenerateImageInput) {
  if (!conversationId) {
    throw Object.assign(new Error('图像操作必须指定会话'), { status: 400 });
  }
  if (!userConversationExists(conversationId, userId)) {
    throw Object.assign(new Error('会话不存在'), { status: 404 });
  }

  const generationId = newId('img');
  const model = sourceAttachmentId ? editImageModel() : textImageModel();
  repo.insertImageGeneration(generationId, userId, prompt, model || null);

  try {
    let image;
    if (sourceAttachmentId) {
      const references = Array.from(new Set((referenceAttachmentIds || []).filter(id => id && id !== sourceAttachmentId)));
      if (references.length > 3) throw new Error('图像编辑最多支持一张主图和三张参考图');
      const sources = await Promise.all([
        loadSourceImage(userId, sourceAttachmentId, conversationId),
        ...references.map(id => loadSourceImage(userId, id, conversationId))
      ]);
      image = await callImageEditApi(prompt, sources, { signal });
    } else {
      image = await callImageApi(prompt, { signal });
    }
    const attachment = await saveImageBuffer(userId, image, conversationId, undefined, undefined, 'output');
    repo.completeImageGeneration(generationId, userId, attachment.id);
    recordImageUsage(userId, generationId, model || null);
    return {
      generationId,
      attachment,
      markdown: `![生成图片](${attachment.public_path})`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '图片生成失败';
    repo.failImageGeneration(generationId, userId, message);
    throw error;
  }
}
