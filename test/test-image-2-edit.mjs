#!/usr/bin/env node
// Test script: image-to-image (image edits) using ColorFlow + gpt-image-2.
// Only API_URL and API_KEY are user-supplied; everything else is hardcoded.
//
// Usage:
//   1. Save the source image as test/source.png
//   2. Fill in API_URL and API_KEY at the top
//   3. node test/test-image-2-edit.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// FILL THESE IN
// ============================================================
const API_URL = '';   // e.g. https://colorflowai.com/v1/images/edits
const API_KEY = '';   // your api key
// ============================================================

if (!API_URL || !API_KEY) {
  console.error('Please fill in API_URL and API_KEY at the top of the script.');
  process.exit(1);
}

// Hardcoded configuration (no env, no fallback, no .env lookup).
const MODEL              = 'gpt-image-2';
const SOURCE_IMAGE_PATH  = path.join(__dirname, 'input.png');           // place your input image here
const PROMPT             = '保留人物主体主要外貌特征与背景构图，转换为细腻日系动漫插画风格，线条干净，色彩明亮柔和，面部自然，高清成品。';
const SIZE               = 'auto';
const QUALITY            = 'low';
const N                  = 1;
const RESPONSE_FORMAT    = 'b64_json';
const OUTPUT_PATH        = path.join(__dirname, 'output-edited.png');
const TIMEOUT_MS         = 5 * 60_000;

function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extFromMime(mime) {
  const m = mime.split('/')[1];
  return m === 'jpeg' ? 'jpg' : m || 'png';
}

async function main() {
  console.log(`POST ${API_URL}`);
  console.log(`model=${MODEL} size=${SIZE === 'auto' ? 'auto (not sent)' : SIZE} quality=${QUALITY} n=${N}`);
  console.log(`format=${RESPONSE_FORMAT} timeout=${TIMEOUT_MS}ms`);
  console.log(`source image: ${SOURCE_IMAGE_PATH}`);
  console.log(`prompt: ${PROMPT}`);

  const t0 = performance.now();

  // ---------- 1. read source image ----------
  let sourceBuffer;
  try {
    sourceBuffer = await fs.readFile(SOURCE_IMAGE_PATH);
  } catch {
    console.error(`\nSource image not found: ${SOURCE_IMAGE_PATH}`);
    console.error(`Save the input image as test/input.png first, then re-run.`);
    process.exit(1);
  }
  const t1 = performance.now();
  console.log(`source size: ${(sourceBuffer.length / 1024).toFixed(1)} KB mime: ${mimeFromPath(SOURCE_IMAGE_PATH)}`);

  // ---------- 2. build multipart form ----------
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', PROMPT);
  form.append('n', String(N));
  if (SIZE && SIZE !== 'auto') form.append('size', SIZE);
  if (QUALITY) form.append('quality', QUALITY);
  form.append('response_format', RESPONSE_FORMAT);
  form.append('image', new Blob([new Uint8Array(sourceBuffer)], { type: mimeFromPath(SOURCE_IMAGE_PATH) }), path.basename(SOURCE_IMAGE_PATH));
  const t2 = performance.now();

  // ---------- 3. POST (request + upstream generation) ----------
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('request timeout')), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`
      },
      body: form,
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const t3 = performance.now();

  // ---------- 4. read response body ----------
  const text = await res.text();
  const t4 = performance.now();

  // ---------- 5. parse JSON ----------
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || text.slice(0, 300));
  }
  const item = data?.data?.[0];
  if (!item?.b64_json) {
    throw new Error('Response has no data[0].b64_json (script is hardcoded for b64_json)');
  }
  const t5 = performance.now();

  // ---------- 6. base64 decode ----------
  const raw = String(item.b64_json).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  const t6 = performance.now();

  // ---------- 7. write file ----------
  await fs.writeFile(OUTPUT_PATH, buffer);
  const t7 = performance.now();

  // ---------- summary ----------
  const sec = (a, b) => ((b - a) / 1000).toFixed(2);
  console.log(`\n分段耗时:`);
  console.log(`  read source image:      ${sec(t0, t1)}s`);
  console.log(`  build multipart form:   ${sec(t1, t2)}s`);
  console.log(`  fetch (upstream gen):   ${sec(t2, t3)}s`);
  console.log(`  res.text() (download):  ${sec(t3, t4)}s`);
  console.log(`  JSON.parse:             ${sec(t4, t5)}s`);
  console.log(`  base64 decode:          ${sec(t5, t6)}s`);
  console.log(`  fs.writeFile:           ${sec(t6, t7)}s`);
  console.log(`  total:                  ${sec(t0, t7)}s`);
  console.log(`\napi JSON size:           ${(text.length / 1024).toFixed(1)} KB`);
  console.log(`output size:              ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`已保存: ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
