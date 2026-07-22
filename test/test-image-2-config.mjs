#!/usr/bin/env node
// Test script: replicate the chat-lite web UI configuration
// for a "生成一张可爱泰迪棕色小狗图片，写实风格" request.
// Only API_URL and API_KEY are user-supplied; everything else is hardcoded.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// FILL THESE IN
// ============================================================
const API_URL = 'https://colorflowai.com/v1/images/generations';   // e.g. https://colorflowai.com/v1/images/generations
const API_KEY = '';   // your api key
// ============================================================

if (!API_URL || !API_KEY) {
  console.error('Please fill in API_URL and API_KEY at the top of the script.');
  process.exit(1);
}

// Hardcoded configuration (no env, no fallback, no .env lookup).
const MODEL            = 'gpt-image-2';
const PROMPT           = '生成一张可爱泰迪棕色小狗图片，写实风格';
const SIZE             = 'auto';
const QUALITY          = 'low';
const N                = 1;
const RESPONSE_FORMAT  = 'b64_json';
const OUTPUT_PATH      = path.join(__dirname, 'output-puppy.png');
const TIMEOUT_MS       = 5 * 60_000;

async function main() {
  console.log(`POST ${API_URL}`);
  console.log(`model=${MODEL} size=${SIZE} quality=${QUALITY} n=${N}`);
  console.log(`format=${RESPONSE_FORMAT} timeout=${TIMEOUT_MS}ms`);
  console.log(`prompt=${PROMPT}`);

  const body = {
    model: MODEL,
    prompt: PROMPT,
    n: N,
    size: SIZE,
    quality: QUALITY,
    response_format: RESPONSE_FORMAT
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('request timeout')), TIMEOUT_MS);

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const t1 = performance.now();

  const text = await res.text();
  const t2 = performance.now();

  let data = {};
  try { data = JSON.parse(text); } catch {}
  const item = data?.data?.[0];
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || text.slice(0, 300));
  }
  if (!item?.url) {
    throw new Error('Response has no data[0].url (script is hardcoded for url response_format)');
  }
  console.log(`\n收到图片 URL: ${item.url}\n`);
  const t3 = performance.now();

  const ac2 = new AbortController();
  const timer2 = setTimeout(() => ac2.abort(new Error('download timeout')), TIMEOUT_MS);
  let imageRes;
  try {
    imageRes = await fetch(item.url, { signal: ac2.signal });
  } finally {
    clearTimeout(timer2);
  }
  if (!imageRes.ok) throw new Error(`图片下载失败 HTTP ${imageRes.status}`);
  const mimeType = imageRes.headers.get('content-type')?.split(';')[0] || 'image/png';
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const t4 = performance.now();

  await fs.writeFile(OUTPUT_PATH, buffer);
  const t5 = performance.now();

  const sec = (a, b) => ((b - a) / 1000).toFixed(2);
  console.log(`分段耗时:`);
  console.log(`  fetch (request + upstream): ${sec(t0, t1)}s`);
  console.log(`  res.text() (download JSON): ${sec(t1, t2)}s`);
  console.log(`  JSON.parse:                  ${sec(t2, t3)}s`);
  console.log(`  download from URL:           ${sec(t3, t4)}s`);
  console.log(`  fs.writeFile:                ${sec(t4, t5)}s`);
  console.log(`  total:                       ${sec(t0, t5)}s`);
  console.log(`  api JSON size:               ${(text.length / 1024).toFixed(1)} KB`);
  console.log(`  image size:                  ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`  mime:                        ${mimeType}`);
  console.log(`已保存: ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
