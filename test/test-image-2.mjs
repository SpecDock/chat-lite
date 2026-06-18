import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// 在这里配置测试参数。
const CONFIG = {
  imagePath: './test/input.png',
  prompt: '把这张图片改成高质量动漫插画风格，保留主体主要特征，线条干净，色彩明亮柔和，高清。',
  outputPath: './test/output-image-2.png'
};

function endpointFromEnv() {
  const explicit = process.env.IMAGE_EDIT_API_URL;
  const base = explicit || process.env.IMAGE_API_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const trimmed = base.replace(/\/+$/, '');
  if (/\/images\/edits$/i.test(trimmed)) return trimmed;
  if (/\/images\/generations$/i.test(trimmed)) return trimmed.replace(/\/images\/generations$/i, '/images/edits');
  return `${trimmed}/images/edits`;
}

function mimeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function firstImageBase64(data) {
  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  return first?.b64_json || first?.base64 || first?.image_base64 || data?.b64_json;
}

function firstImageUrl(data) {
  const first = data?.data?.[0] || data?.images?.[0] || data?.[0];
  return first?.url || first?.image_url || data?.url;
}

function elapsed(start) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

const endpoint = endpointFromEnv();
const apiKey = process.env.IMAGE_EDIT_API_KEY || process.env.IMAGE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY;
const model = process.env.IMAGE_EDIT_MODEL || process.env.IMAGE_MODEL || 'gpt-image-2';
const size = process.env.IMAGE_SIZE || '1024x1024';
const responseFormat = process.env.IMAGE_EDIT_RESPONSE_FORMAT || process.env.IMAGE_RESPONSE_FORMAT || 'b64_json';

if (!apiKey) throw new Error('缺少 IMAGE_EDIT_API_KEY 或 IMAGE_API_KEY/MODEL_API_KEY');
if (!/^https?:\/\//i.test(endpoint)) throw new Error(`IMAGE_EDIT_API_URL 必须是完整 URL，当前为: ${endpoint}`);

const imageBuffer = await readFile(resolve(CONFIG.imagePath));
const form = new FormData();
form.append('model', model);
form.append('prompt', CONFIG.prompt);
form.append('n', '1');
form.append('size', size);
form.append('response_format', responseFormat);
form.append('image', new Blob([new Uint8Array(imageBuffer)], { type: mimeFromPath(CONFIG.imagePath) }), CONFIG.imagePath.split(/[\\/]/).pop() || 'source.png');

console.log('POST', endpoint);
console.log('model:', model);
console.log('response_format:', responseFormat);
const startedAt = performance.now();
let res = await fetch(endpoint, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form
});

let text = await res.text();
let data = text ? JSON.parse(text) : {};
if (!res.ok && /response_format|unsupported|invalid|upstream did not return image output/i.test(data?.error?.message || data?.message || '')) {
  console.log(`response_format=${responseFormat} 不支持，重试不带 response_format`);
  const fallbackForm = new FormData();
  fallbackForm.append('model', model);
  fallbackForm.append('prompt', CONFIG.prompt);
  fallbackForm.append('n', '1');
  fallbackForm.append('size', size);
  fallbackForm.append('image', new Blob([new Uint8Array(imageBuffer)], { type: mimeFromPath(CONFIG.imagePath) }), CONFIG.imagePath.split(/[\\/]/).pop() || 'source.png');
  res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fallbackForm
  });
  text = await res.text();
  data = text ? JSON.parse(text) : {};
}
if (!res.ok) {
  console.error(JSON.stringify(data, null, 2));
  throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
}

let outputBuffer;
const b64 = firstImageBase64(data);
const url = firstImageUrl(data);

if (b64) {
  console.log('收到 base64 图片数据时间:', elapsed(startedAt));
  outputBuffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
} else if (url) {
  const receivedUrlAt = performance.now();
  console.log('收到图片链接时间:', elapsed(startedAt));
  //console.log('下载生成图片:', url);
  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error(`下载失败 HTTP ${imageRes.status}`);
  outputBuffer = Buffer.from(await imageRes.arrayBuffer());
  console.log('下载完成图片时间:', elapsed(startedAt));
  console.log('图片下载耗时:', elapsed(receivedUrlAt));
} else {
  console.error(JSON.stringify(data, null, 2));
  throw new Error('响应里没有 url 或 b64_json 图片');
}

await mkdir(dirname(resolve(CONFIG.outputPath)), { recursive: true });
await writeFile(resolve(CONFIG.outputPath), outputBuffer);
console.log('已保存:', resolve(CONFIG.outputPath));
console.log('总耗时:', elapsed(startedAt));
