import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// 在这里配置测试参数。
const CONFIG = {
  prompt: '生成一张高质量的动漫插画，主题是一个穿着未来感服装的年轻女性，站在充满霓虹灯的城市街道上，夜晚的氛围，线条干净，色彩明亮柔和，高清。',
  outputPath: './test/output-image-2-text.png'
};

const REQUEST_TIMEOUT_MS = Number(process.env.IMAGE_REQUEST_TIMEOUT_MS || 300000);

function elapsed(start) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

async function readJsonResponse(res, label, startedAt) {
  const bodyStart = performance.now();
  const text = await res.text();
  console.log(`${label} 响应体下载完成:`, elapsed(startedAt), `(耗时 ${elapsed(bodyStart)})`, `大小 ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)}MB`);
  const parseStart = performance.now();
  const data = text ? JSON.parse(text) : {};
  console.log(`${label} JSON解析完成:`, elapsed(startedAt), `(耗时 ${elapsed(parseStart)})`);
  return data;
}

async function postJson(endpoint, apiKey, body, label, startedAt) {
  console.log(`${label} 开始:`, elapsed(startedAt));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    console.log(`${label} 收到响应:`, elapsed(startedAt));
    return res;
  } catch (error) {
    console.error(`${label} 请求失败:`, elapsed(startedAt));
    throw error;
  }
}

function endpointFromEnv() {
  const explicit = process.env.TEXT_IMAGE_API_URL;
  const base = explicit || process.env.IMAGE_API_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const trimmed = base.replace(/\/+$/, '');
  if (/\/images\/generations$/i.test(trimmed)) return trimmed;
  if (/\/images\/edits$/i.test(trimmed)) return trimmed.replace(/\/images\/edits$/i, '/images/generations');
  return `${trimmed}/images/generations`;
}

function firstImageBase64(data) {
  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  return first?.b64_json || first?.base64 || first?.image_base64 || data?.b64_json;
}

function firstImageUrl(data) {
  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  return first?.url || first?.image_url || data?.url;
}

const endpoint = endpointFromEnv();
const apiKey = process.env.TEXT_IMAGE_API_KEY || process.env.IMAGE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY;
const model = process.env.TEXT_IMAGE_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2';
const size = process.env.IMAGE_SIZE || '1024x1024';

if (!apiKey) throw new Error('缺少 TEXT_IMAGE_API_KEY 或 IMAGE_API_KEY/MODEL_API_KEY');
if (!/^https?:\/\//i.test(endpoint)) throw new Error(`TEXT_IMAGE_API_URL 必须是完整 URL，当前为: ${endpoint}`);

const body = {
  model,
  prompt: CONFIG.prompt,
  n: 1,
  size,
  response_format: 'b64_json'
};

console.log('POST', endpoint);
console.log('model:', model);
console.log('response_format:', body.response_format);
console.log('timeout:', `${REQUEST_TIMEOUT_MS}ms`);
const startedAt = performance.now();

let res = await postJson(endpoint, apiKey, body, '首次请求', startedAt);

let data = await readJsonResponse(res, '首次请求', startedAt);

if (!res.ok && /response_format|unsupported|invalid|upstream did not return image output/i.test(data?.error?.message || data?.message || '')) {
  console.log('response_format=b64_json 不支持，重试不带 response_format');
  const { response_format, ...fallbackBody } = body;
  res = await postJson(endpoint, apiKey, fallbackBody, '兜底请求', startedAt);
  data = await readJsonResponse(res, '兜底请求', startedAt);
}

if (!res.ok) {
  console.error(JSON.stringify(data, null, 2));
  throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
}

let outputBuffer;
const b64 = firstImageBase64(data);
const url = firstImageUrl(data);

if (b64) {
  const decodeStart = performance.now();
  outputBuffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  console.log('base64 解码完成:', elapsed(startedAt), `(耗时 ${elapsed(decodeStart)})`, `大小 ${(outputBuffer.length / 1024 / 1024).toFixed(2)}MB`);
} else if (url) {
  console.log('下载生成图片:', url);
  const downloadStart = performance.now();
  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error(`下载失败 HTTP ${imageRes.status}`);
  outputBuffer = Buffer.from(await imageRes.arrayBuffer());
  console.log('图片下载完成:', elapsed(startedAt), `(耗时 ${elapsed(downloadStart)})`, `大小 ${(outputBuffer.length / 1024 / 1024).toFixed(2)}MB`);
} else {
  console.error(JSON.stringify(data, null, 2));
  throw new Error('响应里没有 url 或 b64_json 图片');
}

await mkdir(dirname(resolve(CONFIG.outputPath)), { recursive: true });
const writeStart = performance.now();
await writeFile(resolve(CONFIG.outputPath), outputBuffer);
console.log('已保存:', resolve(CONFIG.outputPath));
console.log('文件写入完成:', elapsed(startedAt), `(耗时 ${elapsed(writeStart)})`);
console.log('总耗时:', elapsed(startedAt));
