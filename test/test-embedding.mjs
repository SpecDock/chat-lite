// Probe your custom embedding endpoint end-to-end.
// Usage: node test/test-embedding.mjs
// Reads EMBEDDING_* env vars; no fallback. Exits 0 on success, non-zero on failure.

import { readFile } from 'node:fs/promises';

const ENV_PATH = new URL('../.env', import.meta.url);

function loadEnv() {
  return readFile(ENV_PATH, 'utf8').then((raw) => {
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return env;
  }).catch(() => ({}));
}

function pick(env, name) {
  const v = process.env[name] || env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function normEndpoint(base) {
  if (!base) throw new Error(`embedding base url missing`);
  return base.replace(/\/+$/, '') + '/embeddings';
}

async function probe() {
  const env = await loadEnv();

  const apiKey = pick(env, 'EMBEDDING_API_KEY');
  const baseUrl = pick(env, 'EMBEDDING_BASE_URL');
  const model = pick(env, 'EMBEDDING_MODEL');
  const expectedDim = Number(pick(env, 'EMBEDDING_DIMENSIONS') || 0);

  if (!apiKey || !baseUrl || !model) {
    console.error('missing env: need EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL');
    process.exit(2);
  }

  const samples = [
    'hello world',
    'chat-lite 私有部署测试 embedding',
    'The quick brown fox jumps over the lazy dog.',
    '将绿色数字 93 改为 10，并保留其它 UI',
  ];

  const url = normEndpoint(baseUrl);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: samples,
      encoding_format: 'float',
    }),
  });
  const text = await res.text();
  const t1 = Date.now();

  console.log('endpoint :', url);
  console.log('model    :', model);
  console.log('status   :', res.status);
  console.log('latency  :', `${t1 - t0}ms`);
  console.log('body.size:', text.length);

  if (!res.ok) {
    console.error('body:', text.slice(0, 500));
    process.exit(1);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    console.error('json parse failed:', e.message);
    console.error('body:', text.slice(0, 500));
    process.exit(1);
  }

  const data = body.data || body.embeddings;
  if (!Array.isArray(data) || data.length === 0) {
    console.error('no embeddings returned:', JSON.stringify(body).slice(0, 500));
    process.exit(1);
  }

  const first = data[0].embedding || data[0].values || data[0];
  if (!Array.isArray(first)) {
    console.error('embedding is not an array:', JSON.stringify(data[0]).slice(0, 500));
    process.exit(1);
  }

  console.log('returned :', data.length, 'vectors');
  console.log('dim      :', first.length);
  if (expectedDim && expectedDim !== first.length) {
    console.error(`dimension mismatch: expected ${expectedDim}, got ${first.length}`);
    console.error('reminder: EMBEDDING_DIMENSIONS must equal the model vector size, otherwise rag.db must be rebuilt');
    process.exit(1);
  }

  // Quick numeric sanity
  const head = first.slice(0, 4).map((n) => Number(n).toFixed(4));
  const tail = first.slice(-4).map((n) => Number(n).toFixed(4));
  const allZero = first.every((n) => Number(n) === 0);
  if (allZero) {
    console.error('all-zero vector: endpoint is alive but returning empty embeddings');
    process.exit(1);
  }

  console.log('head[4] :', head);
  console.log('tail[4] :', tail);

  // Cross-vector cosine to confirm input independence
  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }
  function norm(a) {
    return Math.sqrt(dot(a, a));
  }
  const v0 = data[0].embedding;
  const v1 = data[1].embedding;
  const v2 = data[2].embedding;
  const v3 = data[3].embedding;
  const cos01 = dot(v0, v1) / (norm(v0) * norm(v1));
  const cos02 = dot(v0, v2) / (norm(v0) * norm(v2));
  const cos03 = dot(v0, v3) / (norm(v0) * norm(v3));
  console.log('cosine(s0,s1) ~', cos01.toFixed(4), '(hello vs chat-lite CN)');
  console.log('cosine(s0,s2) ~', cos02.toFixed(4), '(hello vs english pangram)');
  console.log('cosine(s0,s3) ~', cos03.toFixed(4), '(hello vs CN edit intent)');

  console.log('OK');
}

probe().catch((e) => {
  console.error('fatal:', e?.message || e);
  process.exit(1);
});