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
  referenceAttachmentIds?: string[];
  signal?: AbortSignal;
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
  if (/\/v1\/image_generation$/i.test(trimmed)) return trimmed;
  return `${trimmed}/images/edits`;
}

function textImageModel() {
  return process.env.TEXT_IMAGE_MODEL || '';
}

function editImageModel() {
  return process.env.IMAGE_EDIT_MODEL || '';
}

function textImageResponseFormat() {
  return process.env.TEXT_IMAGE_RESPONSE_FORMAT || 'b64_json';
}

function editImageResponseFormat() {
  return process.env.IMAGE_EDIT_RESPONSE_FORMAT || 'b64_json';
}

function imageSize() {
  const v = process.env.TEXT_IMAGE_SIZE;
  if (!v || v === 'auto') return undefined;
  return v;
}

function imageEditSize() {
  const v = process.env.IMAGE_EDIT_SIZE;
  if (!v || v === 'auto') return undefined;
  return v;
}

function textImageQuality() {
  return process.env.TEXT_IMAGE_QUALITY || undefined;
}

function imageEditQuality() {
  return process.env.IMAGE_EDIT_QUALITY || undefined;
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

async function callImageApi(prompt: string, signal?: AbortSignal) {
  const endpoint = imageApiEndpoint();
  const apiKey = textImageApiKey();
  const model = textImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('文生图 API 未配置：请设置 TEXT_IMAGE_API_URL、TEXT_IMAGE_API_KEY、TEXT_IMAGE_MODEL');

  const size = imageSize();
  const quality = textImageQuality();
  const baseBody: Record<string, unknown> = { model, prompt, n: 1 };
  if (size) baseBody.size = size;
  if (quality) baseBody.quality = quality;
  let data: any;
  try {
    data = await postImageGeneration(endpoint, apiKey, { ...baseBody, response_format: textImageResponseFormat() }, signal);
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (!/response_format|unsupported|invalid|upstream did not return image output/i.test(msg)) throw error;
    data = await postImageGeneration(endpoint, apiKey, baseBody, signal);
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

function appendEditImages(form: FormData, sources: SourceImage[]) {
  const field = sources.length > 1 ? 'image[]' : 'image';
  for (const source of sources) {
    form.append(field, new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }), source.filename || 'source.png');
  }
}

async function callImageEditApi(prompt: string, sources: SourceImage[], signal?: AbortSignal) {
  const endpoint = imageEditApiEndpoint();
  const apiKey = editImageApiKey();
  const model = editImageModel();
  if (!endpoint || !apiKey || !model) throw new Error('图生图 API 未配置：请设置 IMAGE_EDIT_API_URL、IMAGE_EDIT_API_KEY、IMAGE_EDIT_MODEL');
  if (!sources.length) throw new Error('图生图至少需要一张主图');

  if (isMiniMaxImageGenerationEndpoint(endpoint)) {
    if (sources.length > 1) throw new Error('当前 MiniMax 图生图接口未验证多参考图；请改用支持 image[] 的 OpenAI 兼容 /images/edits 接口');
    return callMiniMaxImageToImage(endpoint, apiKey, model, prompt, sources[0], signal);
  }

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  const editSize = imageEditSize();
  if (editSize) form.append('size', editSize);
  form.append('response_format', editImageResponseFormat());
  const editQuality = imageEditQuality();
  if (editQuality) form.append('quality', editQuality);
  appendEditImages(form, sources);

  let res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  });
  let text = await res.text();
  let data = parseImageApiJson(text, res, '图生图 API');
  if (!res.ok && /response_format|unsupported|invalid|upstream did not return image output/i.test(data?.error?.message || data?.message || '')) {
    const fallbackForm = new FormData();
    fallbackForm.append('model', model);
    fallbackForm.append('prompt', prompt);
    fallbackForm.append('n', '1');
    if (editSize) fallbackForm.append('size', editSize);
    if (editQuality) fallbackForm.append('quality', editQuality);
    appendEditImages(fallbackForm, sources);
    res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: fallbackForm,
      signal
    });
    text = await res.text();
    data = parseImageApiJson(text, res, '图生图 API');
  }
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

async function callMiniMaxImageToImage(endpoint: string, apiKey: string, model: string, prompt: string, source: SourceImage, signal?: AbortSignal) {
  const preferredMode: MiniMaxSourceMode = process.env.IMAGE_EDIT_SOURCE_MODE === 'signed-url' ? 'signed-url' : 'base64';
  const fallbackMode: MiniMaxSourceMode = preferredMode === 'base64' ? 'signed-url' : 'base64';

  try {
    return await callMiniMaxImageToImageWithSourceMode(endpoint, apiKey, model, prompt, source, preferredMode, signal);
  } catch (error) {
    console.warn(`[image_to_image] MiniMax ${preferredMode} source failed, retrying ${fallbackMode}:`, error instanceof Error ? error.message : error);
    return callMiniMaxImageToImageWithSourceMode(endpoint, apiKey, model, prompt, source, fallbackMode, signal);
  }
}

async function callMiniMaxImageToImageWithSourceMode(endpoint: string, apiKey: string, model: string, prompt: string, source: SourceImage, sourceMode: MiniMaxSourceMode, signal?: AbortSignal) {
  const body: Record<string, unknown> = {
    model,
    prompt,
    response_format: editImageResponseFormat(),
    n: 1,
    subject_reference: [{
      type: process.env.IMAGE_EDIT_REFERENCE_TYPE || 'character',
      image_file: miniMaxSourceImage(source, sourceMode)
    }]
  };
  if (process.env.IMAGE_EDIT_ASPECT_RATIO) body.aspect_ratio = process.env.IMAGE_EDIT_ASPECT_RATIO;

  const res = await fetch(assertHttpUrl(endpoint, 'IMAGE_EDIT_API_URL'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
  const text = await res.text();
  const data = parseImageApiJson(text, res, 'MiniMax 图生图 API');
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

async function loadSourceImage(userId: string, attachmentId: string, conversationId?: string): Promise<SourceImage> {
  const normalizedAttachmentId = normalizeAttachmentId(attachmentId);
  if (!conversationId) throw Object.assign(new Error('图像操作必须指定会话'), { status: 400 });
  const att = repo.findUserAttachmentPath(normalizedAttachmentId, userId, conversationId);
  if (!att) throw Object.assign(new Error(`图片不存在：${normalizedAttachmentId || attachmentId}`), { status: 404 });
  return {
    attachmentId: normalizedAttachmentId,
    buffer: await readFile(att.file_path),
    mimeType: att.mime_type || 'image/png',
    filename: att.original_name || 'source.png'
  };
}

function textImageMaxBatch() {
  const value = Number(process.env.TEXT_IMAGE_MAX_BATCH);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 6;
}

function textImageMaxParallel() {
  const value = Number(process.env.TEXT_IMAGE_MAX_PARALLEL);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4;
}

export type GenerateImageBatchResult =
  | { prompt: string; ok: true; markdown: string }
  | { prompt: string; ok: false; error: string };

/**
 * Batch text-to-image generation. Each item reuses generateImageForUser so the
 * existing image_generations row + image_usage record + attachment lifecycle
 * stay identical to the single-image path.
 */
export async function generateImageBatchForUser(input: {
  userId: string;
  conversationId: string | null;
  prompts: string[];
  signal?: AbortSignal;
}): Promise<GenerateImageBatchResult[]> {
  const maxBatch = textImageMaxBatch();
  const parallel = textImageMaxParallel();
  const cleaned = (input.prompts || [])
    .map(p => String(p == null ? '' : p).trim())
    .filter(p => p.length > 0)
    .slice(0, maxBatch);
  const results: GenerateImageBatchResult[] = [];
  for (let i = 0; i < cleaned.length; i += parallel) {
    const chunk = cleaned.slice(i, i + parallel);
    if (input.signal?.aborted) {
      const reason = input.signal.reason instanceof Error ? input.signal.reason.message : '请求已取消';
      chunk.forEach(prompt => results.push({ prompt, ok: false, error: reason }));
      continue;
    }
    const settled = await Promise.allSettled(chunk.map(prompt =>
      generateImageForUser({
        userId: input.userId,
        prompt,
        conversationId: input.conversationId || undefined,
        signal: input.signal
      })
    ));
    settled.forEach((s, idx) => {
      const prompt = chunk[idx];
      if (s.status === 'fulfilled') {
        results.push({ prompt, ok: true, markdown: s.value.markdown });
      } else {
        const message = s.reason instanceof Error ? s.reason.message : String(s.reason || '生成失败');
        results.push({ prompt, ok: false, error: message });
      }
    });
  }
  return results;
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
      image = await callImageEditApi(prompt, sources, signal);
    } else {
      image = await callImageApi(prompt, signal);
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
