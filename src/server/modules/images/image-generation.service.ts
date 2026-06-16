import { readFile } from 'node:fs/promises';
import { newId } from '../../core/security.js';
import { userConversationExists } from '../uploads/upload.repo.js';
import { createSignedImageSourceUrl } from '../uploads/files.js';
import { saveImageBuffer } from '../uploads/upload.service.js';
import { recordImageUsage } from '../usage/usage.service.js';
import * as repo from './image.repo.js';

type GenerateImageInput = {
  userId: string;
  prompt: string;
  conversationId?: string;
  sourceAttachmentId?: string;
};

type SourceImage = { attachmentId: string; buffer: Buffer; mimeType: string; filename: string };

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
  return process.env.TEXT_IMAGE_API_KEY || process.env.IMAGE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
}

function editImageApiKey() {
  return process.env.IMAGE_EDIT_API_KEY || process.env.IMAGE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
}

function imageApiEndpoint() {
  const base = process.env.TEXT_IMAGE_API_URL || process.env.IMAGE_API_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || '';
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  return /\/images\/generations$/.test(trimmed) ? trimmed : `${trimmed}/images/generations`;
}

function imageEditApiEndpoint() {
  const explicit = process.env.IMAGE_EDIT_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = process.env.IMAGE_API_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || '';
  if (!base) return '';
  const trimmed = base.replace(/\/+$/, '');
  if (/\/images\/edits$/.test(trimmed)) return trimmed;
  if (/\/images\/generations$/.test(trimmed)) return trimmed.replace(/\/images\/generations$/, '/images/edits');
  return `${trimmed}/images/edits`;
}

function textImageModel() {
  return process.env.TEXT_IMAGE_MODEL || process.env.IMAGE_MODEL || '';
}

function editImageModel() {
  return process.env.IMAGE_EDIT_MODEL || process.env.IMAGE_MODEL || '';
}

function mimeFromUrl(url: string) {
  const clean = url.split('?')[0]?.toLowerCase() || '';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function postImageGeneration(endpoint: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(assertHttpUrl(endpoint, 'IMAGE_API_URL'), {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `图片生成失败 HTTP ${res.status}`);
  return data;
}

async function callImageApi(prompt: string) {
  const endpoint = imageApiEndpoint();
  const apiKey = textImageApiKey();
  const model = textImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('文生图 API 未配置：请设置 TEXT_IMAGE_API_URL、TEXT_IMAGE_API_KEY、TEXT_IMAGE_MODEL');

  const size = process.env.IMAGE_SIZE || '1024x1024';
  const baseBody = { model, prompt, n: 1, size };
  let data: any;
  try {
    data = await postImageGeneration(endpoint, apiKey, { ...baseBody, response_format: 'b64_json' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!/response_format|unsupported|invalid/i.test(msg)) throw error;
    data = await postImageGeneration(endpoint, apiKey, baseBody);
  }

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

  throw new Error('图片生成 API 未返回 url 或 b64_json');
}

async function callImageEditApi(prompt: string, source: SourceImage) {
  const endpoint = imageEditApiEndpoint();
  const apiKey = editImageApiKey();
  const model = editImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('图生图 API 未配置：请设置 IMAGE_EDIT_API_URL、IMAGE_EDIT_API_KEY、IMAGE_EDIT_MODEL');

  if (isMiniMaxImageGenerationEndpoint(endpoint)) {
    return callMiniMaxImageToImage(endpoint, apiKey, model, prompt, source);
  }

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', process.env.IMAGE_SIZE || '1024x1024');
  form.append('image', new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }), source.filename || 'source.png');

  const res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `图生图失败 HTTP ${res.status}`);

  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  const b64 = first?.b64_json || first?.base64 || first?.image_base64;
  const url = first?.url || first?.image_url;
  if (b64) return { buffer: Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64'), mimeType: 'image/png', filename: 'generated.png' };
  if (url) {
    const image = await fetch(url);
    if (!image.ok) throw new Error(`下载生成图片失败 HTTP ${image.status}`);
    const mimeType = image.headers.get('content-type')?.split(';')[0] || mimeFromUrl(url);
    return { buffer: Buffer.from(await image.arrayBuffer()), mimeType, filename: `generated.${mimeType.split('/')[1] || 'png'}` };
  }
  throw new Error('图生图 API 未返回 url 或 b64_json');
}

function isMiniMaxImageGenerationEndpoint(endpoint: string) {
  return /minimax/i.test(endpoint) || /\/v1\/image_generation\/?$/i.test(endpoint);
}

type MiniMaxSourceMode = 'base64' | 'signed-url';

function miniMaxSourceImage(source: SourceImage, mode: MiniMaxSourceMode) {
  if (mode === 'base64') {
    return `data:${source.mimeType};base64,${source.buffer.toString('base64')}`;
  }
  return createSignedImageSourceUrl(source.attachmentId);
}

async function callMiniMaxImageToImage(endpoint: string, apiKey: string, model: string, prompt: string, source: SourceImage) {
  const preferredMode: MiniMaxSourceMode = process.env.IMAGE_EDIT_SOURCE_MODE === 'signed-url' ? 'signed-url' : 'base64';
  const fallbackMode: MiniMaxSourceMode = preferredMode === 'base64' ? 'signed-url' : 'base64';

  try {
    return await callMiniMaxImageToImageWithSourceMode(endpoint, apiKey, model, prompt, source, preferredMode);
  } catch (error) {
    console.warn(`[image_to_image] MiniMax ${preferredMode} source failed, retrying ${fallbackMode}:`, error instanceof Error ? error.message : error);
    return callMiniMaxImageToImageWithSourceMode(endpoint, apiKey, model, prompt, source, fallbackMode);
  }
}

async function callMiniMaxImageToImageWithSourceMode(endpoint: string, apiKey: string, model: string, prompt: string, source: SourceImage, sourceMode: MiniMaxSourceMode) {
  const body: Record<string, unknown> = {
    model,
    prompt,
    response_format: process.env.IMAGE_RESPONSE_FORMAT || 'url',
    n: 1,
    subject_reference: [{
      type: process.env.IMAGE_EDIT_REFERENCE_TYPE || 'character',
      image_file: miniMaxSourceImage(source, sourceMode)
    }]
  };
  if (process.env.IMAGE_ASPECT_RATIO) body.aspect_ratio = process.env.IMAGE_ASPECT_RATIO;

  const res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  const baseResp = data?.base_resp;
  if (!res.ok || (baseResp && Number(baseResp.status_code) !== 0)) {
    throw new Error(baseResp?.status_msg || data?.error?.message || data?.message || `图生图失败 HTTP ${res.status}`);
  }

  const url = data?.data?.image_urls?.[0] || data?.image_urls?.[0] || data?.data?.[0]?.url || data?.url;
  const b64 = data?.data?.image_base64?.[0] || data?.data?.image_base64s?.[0] || data?.data?.images?.[0]?.b64_json || data?.b64_json;
  if (b64) return { buffer: Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64'), mimeType: 'image/png', filename: 'generated.png' };
  if (url) {
    const image = await fetch(url);
    if (!image.ok) throw new Error(`下载生成图片失败 HTTP ${image.status}`);
    const mimeType = image.headers.get('content-type')?.split(';')[0] || mimeFromUrl(url);
    return { buffer: Buffer.from(await image.arrayBuffer()), mimeType, filename: `generated.${mimeType.split('/')[1] || 'png'}` };
  }
  throw new Error('MiniMax 图生图 API 未返回 image_urls 或 base64 图片');
}

async function loadSourceImage(userId: string, attachmentId: string): Promise<SourceImage> {
  const normalizedAttachmentId = normalizeAttachmentId(attachmentId);
  const att = repo.findUserAttachmentPath(normalizedAttachmentId, userId);
  if (!att) throw Object.assign(new Error(`图片不存在：${normalizedAttachmentId || attachmentId}`), { status: 404 });
  return {
    attachmentId: normalizedAttachmentId,
    buffer: await readFile(att.file_path),
    mimeType: att.mime_type || 'image/png',
    filename: att.original_name || 'source.png'
  };
}

export async function generateImageForUser({ userId, prompt, conversationId, sourceAttachmentId }: GenerateImageInput) {
  if (conversationId && !userConversationExists(conversationId, userId)) {
    throw Object.assign(new Error('会话不存在'), { status: 404 });
  }

  const generationId = newId('img');
  const model = sourceAttachmentId ? editImageModel() : textImageModel();
  repo.insertImageGeneration(generationId, userId, prompt, model || null);

  try {
    const image = sourceAttachmentId
      ? await callImageEditApi(prompt, await loadSourceImage(userId, sourceAttachmentId))
      : await callImageApi(prompt);
    const attachment = await saveImageBuffer(userId, image, conversationId);
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
