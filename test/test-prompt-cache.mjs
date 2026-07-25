#!/usr/bin/env node

import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';

dotenv.config();

const API_KEY = process.env.MODEL_API_KEY || '';
const BASE_URL = process.env.MODEL_BASE_URL || '';
const MODEL = process.env.MODEL_NAME || '';
const REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_INTERVAL_MS = 1_000;
const SUMMARY_LIMIT = 160;
const MODE_FLAGS = ['--explicit', '--explicit-developer', '--explicit-image'];
const SELECTED_MODE_FLAGS = [...new Set(process.argv.filter((argument) => MODE_FLAGS.includes(argument)))];
const MODE = SELECTED_MODE_FLAGS[0]?.slice(2) || 'implicit';
const EXPLICIT_MODE = MODE !== 'implicit';
const HELP_REQUESTED = process.argv.includes('--help') || process.argv.includes('-h');

function buildEndpoint(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function buildStableSystemPrefix(runId) {
  const topics = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const actions = ['preserve', 'retain', 'verify', 'compare', 'index', 'record', 'inspect', 'confirm'];
  const paragraphs = [
    `Stable prompt-cache probe reference ${runId}. Follow every numbered paragraph as fixed context and answer only the final user message.`,
  ];
  let length = paragraphs[0].length;

  for (let index = 1; length < 7_000; index += 1) {
    const number = String(index).padStart(3, '0');
    const topic = topics[(index - 1) % topics.length];
    const action = actions[(index * 3) % actions.length];
    const paragraph = `Paragraph ${number}: ${action} the ${topic} cache marker P${number}. Keep ordering deterministic, treat rule ${index * 17} as reference data, and do not summarize this paragraph unless the final user request asks for it.`;
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }

  return paragraphs.join('\n\n');
}

const ENDPOINT = buildEndpoint(BASE_URL);
const PROBE_RUN_ID = randomBytes(8).toString('hex');
const STABLE_SYSTEM_PREFIX = buildStableSystemPrefix(PROBE_RUN_ID);
const NEGATIVE_SYSTEM_PREFIX = `#${STABLE_SYSTEM_PREFIX.slice(1)}`;
const TAIL_A = 'Tail A: Reply with the single word ALPHA.';
const TAIL_B = 'Tail B: Reply with the single word BRAVO.';
const FIXED_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'prompt_cache_probe_dummy',
      description: 'A fixed dummy tool that must not be called during this cache probe.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            enum: ['unused'],
          },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
  },
];

function requestMessages(systemPrefix, userTail) {
  if (MODE === 'explicit-image') {
    return [
      { role: 'system', content: systemPrefix },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Fixed image cache boundary input.' },
          {
            type: 'image_url',
            image_url: { url: FIXED_IMAGE_DATA_URL, detail: 'low' },
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
      { role: 'user', content: userTail },
    ];
  }

  if (EXPLICIT_MODE) {
    return [
      {
        role: MODE === 'explicit-developer' ? 'developer' : 'system',
        content: [{ type: 'text', text: systemPrefix, prompt_cache_breakpoint: { mode: 'explicit' } }],
      },
      { role: 'user', content: userTail },
    ];
  }

  return [
    { role: 'system', content: systemPrefix },
    { role: 'user', content: userTail },
  ];
}

function requestBody(systemPrefix, userTail) {
  return {
    model: MODEL,
    ...(EXPLICIT_MODE ? {
      prompt_cache_key: `chat-lite-cache-probe-${PROBE_RUN_ID}`,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    } : {}),
    messages: requestMessages(systemPrefix, userTail),
    tools: TOOLS,
    tool_choice: 'none',
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 16,
  };
}

function requestIdFrom(response) {
  return response.headers.get('x-request-id')
    || response.headers.get('request-id')
    || response.headers.get('openai-request-id')
    || '(none)';
}

function textFromPart(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.content || part?.value || '';
  }).join('');
}

function meaningfulDelta(delta) {
  const text = textFromPart(delta?.content);
  if (text.trim()) return text;

  const reasoning = textFromPart(
    delta?.reasoning_content
      ?? delta?.reasoning
      ?? delta?.thinking,
  );
  if (reasoning.trim()) return reasoning;

  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    return delta.tool_calls.map((call) => {
      const name = call?.function?.name || call?.name || 'tool';
      const args = call?.function?.arguments || call?.arguments || '';
      return `${name}${args ? `:${args}` : ''}`;
    }).join(' ');
  }

  return '';
}

function createSseParser(onPayload) {
  let dataLines = [];

  function dispatch() {
    if (dataLines.length === 0) return false;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data.trim() === '[DONE]') return true;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch (cause) {
      throw new Error(`SSE data JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    onPayload(payload);
    return false;
  }

  return {
    pushLine(rawLine) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '') return dispatch();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      return false;
    },
    finish() {
      return dispatch();
    },
  };
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function usageMetrics(usage) {
  const input = numberOrUndefined(usage?.prompt_tokens ?? usage?.input_tokens);
  const output = numberOrUndefined(usage?.completion_tokens ?? usage?.output_tokens);
  const total = numberOrUndefined(usage?.total_tokens) ?? (
    input !== undefined && output !== undefined ? input + output : undefined
  );
  const cached = numberOrUndefined(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens,
  ) ?? 0;
  const cacheWrite = numberOrUndefined(
    usage?.prompt_tokens_details?.cache_write_tokens
      ?? usage?.input_tokens_details?.cache_write_tokens,
  ) ?? 0;
  const cacheRate = input && input > 0 ? (cached / input) * 100 : 0;
  return { input, output, total, cached, cacheWrite, cacheRate };
}

function formatNumber(value) {
  return value === undefined ? 'n/a' : String(value);
}

async function runProbe(label, systemPrefix, userTail) {
  const startedAt = performance.now();
  let firstDeltaAt;
  let usage;
  let summary = '';

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(requestBody(systemPrefix, userTail)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const requestId = requestIdFrom(response);
  if (!response.ok) {
    const responseBody = await response.text();
    console.error(`\n[${label}] HTTP失败 status=${response.status} request_id=${requestId}`);
    console.error(`响应体(最多500字符): ${responseBody.slice(0, 500)}`);
    throw new Error(`${label} request failed`);
  }
  if (!response.body) throw new Error(`${label} response has no stream body (request_id=${requestId})`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser((payload) => {
    if (payload?.usage) usage = payload.usage;
    for (const choice of payload?.choices || []) {
      const delta = meaningfulDelta(choice?.delta);
      if (!delta.trim()) continue;
      if (firstDeltaAt === undefined) firstDeltaAt = performance.now();
      if (summary.length < SUMMARY_LIMIT) {
        summary += delta.slice(0, SUMMARY_LIMIT - summary.length);
      }
    }
  });

  let buffer = '';
  let doneSeen = false;
  while (!doneSeen) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0 && !doneSeen) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      doneSeen = parser.pushLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  if (doneSeen) {
    await reader.cancel();
  } else {
    buffer += decoder.decode();
    if (buffer) doneSeen = parser.pushLine(buffer);
    if (!doneSeen) parser.finish();
  }

  const finishedAt = performance.now();
  const metrics = usageMetrics(usage);
  const ttft = firstDeltaAt === undefined ? undefined : firstDeltaAt - startedAt;
  const cleanSummary = summary.replace(/\s+/g, ' ').trim() || '(empty)';

  console.log(`\n[${label}] request_id=${requestId}`);
  console.log(`  tokens: input=${formatNumber(metrics.input)} output=${formatNumber(metrics.output)} total=${formatNumber(metrics.total)}`);
  console.log(`  cache: cached=${metrics.cached} cache_write_tokens=${metrics.cacheWrite} rate=${metrics.cacheRate.toFixed(2)}%`);
  console.log(`  timing: TTFT=${ttft === undefined ? 'n/a' : `${ttft.toFixed(0)}ms`} total=${(finishedAt - startedAt).toFixed(0)}ms`);
  console.log(`  响应摘要: ${cleanSummary}`);

  return { label, ...metrics, ttft, totalTime: finishedAt - startedAt };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  if (SELECTED_MODE_FLAGS.length > 1) {
    console.error(`模式参数冲突: ${SELECTED_MODE_FLAGS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (HELP_REQUESTED) {
    console.log('用法:');
    console.log('  node test/test-prompt-cache.mjs             # implicit模式');
    console.log('  node test/test-prompt-cache.mjs --explicit  # explicit模式');
    console.log('  node test/test-prompt-cache.mjs --explicit-developer');
    console.log('  node test/test-prompt-cache.mjs --explicit-image');
    return;
  }

  console.log('Prompt cache流式探测');
  console.log(`mode=${MODE}`);
  console.log(`endpoint=${ENDPOINT || '(not configured)'}`);
  console.log(`model=${MODEL || '(not configured)'}`);
  console.log(`api_key configured=${Boolean(API_KEY)}`);
  console.log(`probe_run_id=${PROBE_RUN_ID}`);
  console.log(`stable_prefix_chars=${STABLE_SYSTEM_PREFIX.length}`);

  if (!ENDPOINT || !MODEL || !API_KEY) {
    console.error('配置缺失：仅使用MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME，请检查.env。');
    process.exitCode = 1;
    return;
  }

  const probes = [
    ['cold', STABLE_SYSTEM_PREFIX, TAIL_A],
    ['prefix-hit', STABLE_SYSTEM_PREFIX, TAIL_B],
    ['exact-hot', STABLE_SYSTEM_PREFIX, TAIL_B],
    ['negative-control', NEGATIVE_SYSTEM_PREFIX, TAIL_B],
  ];
  const results = [];

  for (let index = 0; index < probes.length; index += 1) {
    if (index > 0) await delay(REQUEST_INTERVAL_MS);
    const [label, systemPrefix, userTail] = probes[index];
    results.push(await runProbe(label, systemPrefix, userTail));
  }

  const prefixHit = results.find((result) => result.label === 'prefix-hit');
  const exactHot = results.find((result) => result.label === 'exact-hot');
  const negativeControl = results.find((result) => result.label === 'negative-control');

  console.log(`\n提示性比较: negative-control cached=${negativeControl?.cached ?? 0}，该值不参与硬失败判定。`);
  if (EXPLICIT_MODE) {
    const labels = {
      explicit: ['EXPLICIT_PREFIX_SUPPORTED', 'EXPLICIT_EXACT_ONLY', 'EXPLICIT_NOT_CONFIRMED'],
      'explicit-developer': ['EXPLICIT_DEVELOPER_SUPPORTED', 'EXPLICIT_DEVELOPER_EXACT_ONLY', 'EXPLICIT_DEVELOPER_NOT_CONFIRMED'],
      'explicit-image': ['EXPLICIT_IMAGE_SUPPORTED', 'EXPLICIT_IMAGE_EXACT_ONLY', 'EXPLICIT_IMAGE_NOT_CONFIRMED'],
    }[MODE];

    if ((prefixHit?.cached ?? 0) > 0) {
      console.log(labels[0]);
      return;
    }
    if ((exactHot?.cached ?? 0) > 0) {
      console.log(labels[1]);
      console.log('已观察到完整请求命中，但breakpoint未观察到断点后尾部变化命中。');
      process.exitCode = 2;
      return;
    }

    console.log(labels[2]);
    process.exitCode = 1;
    return;
  }

  if ((prefixHit?.cached ?? 0) > 0) {
    console.log('PREFIX_SUPPORTED');
    return;
  }
  if ((exactHot?.cached ?? 0) > 0) {
    console.log('EXACT_ONLY_CONFIRMED');
    console.log('已确认完整请求缓存，但本次未观察到仅修改尾部时复用稳定前缀。');
    return;
  }

  console.log('NOT_CONFIRMED');
  process.exitCode = 1;
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`探测失败: ${message}`);
  process.exitCode = 1;
});
