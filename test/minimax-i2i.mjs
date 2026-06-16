import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

// 在这里配置测试参数。
const CONFIG = {
  imagePath: './test/input.png',
  prompt: '将原图转换为高质量动漫插画风格，保留人物/主体主要特征，线条干净，色彩明亮柔和，高清。',
  outputPath: './test/output.png'
};

const imagePath = CONFIG.imagePath;
const prompt = CONFIG.prompt;
const outputPath = CONFIG.outputPath;

if (!imagePath || !prompt || !outputPath) {
  console.log('请先在 test/minimax-i2i.mjs 顶部 CONFIG 里配置 imagePath、prompt、outputPath');
  process.exit(1);
}

const endpoint = process.env.IMAGE_EDIT_API_URL || 'https://api.minimaxi.com/v1/image_generation';
const apiKey = process.env.IMAGE_EDIT_API_KEY;
const model = process.env.IMAGE_EDIT_MODEL || 'image-01';

if (!apiKey) throw new Error('缺少 IMAGE_EDIT_API_KEY');
if (!/^https?:\/\//i.test(endpoint)) throw new Error(`IMAGE_EDIT_API_URL 必须是完整 URL，当前为: ${endpoint}`);

function mimeFromPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function firstImageUrl(data) {
  return data?.data?.image_urls?.[0] || data?.image_urls?.[0] || data?.data?.[0]?.url || data?.url;
}

function firstImageBase64(data) {
  return data?.data?.image_base64?.[0] || data?.data?.image_base64s?.[0] || data?.data?.images?.[0]?.b64_json || data?.b64_json;
}

const sourceBuffer = await readFile(resolve(imagePath));
const sourceDataUrl = `data:${mimeFromPath(imagePath)};base64,${sourceBuffer.toString('base64')}`;

const body = {
  model,
  prompt,
  response_format: process.env.IMAGE_RESPONSE_FORMAT || 'url',
  aspect_ratio: process.env.IMAGE_ASPECT_RATIO || '1:1',
  n: 1,
  subject_reference: [
    {
      type: process.env.IMAGE_EDIT_REFERENCE_TYPE || 'character',
      image_file: sourceDataUrl
    }
  ]
};

console.log('POST', endpoint);
const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(body)
});

const text = await res.text();
const data = text ? JSON.parse(text) : {};
const baseResp = data?.base_resp;

if (!res.ok || (baseResp && Number(baseResp.status_code) !== 0)) {
  console.error(JSON.stringify(data, null, 2));
  throw new Error(baseResp?.status_msg || data?.error?.message || data?.message || `HTTP ${res.status}`);
}

let outputBuffer;
const b64 = firstImageBase64(data);
const url = firstImageUrl(data);

if (b64) {
  outputBuffer = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
} else if (url) {
  console.log('下载生成图片:', url);
  const imageRes = await fetch(url);
  if (!imageRes.ok) throw new Error(`下载失败 HTTP ${imageRes.status}`);
  outputBuffer = Buffer.from(await imageRes.arrayBuffer());
} else {
  console.error(JSON.stringify(data, null, 2));
  throw new Error('响应里没有 image_urls 或 base64 图片');
}

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), outputBuffer);
console.log('已保存:', resolve(outputPath));
