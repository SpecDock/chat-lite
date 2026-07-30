#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 180_000;
const REQUEST_INTERVAL_MS = 1_000;
const ROUND_COUNT = 5;
const LONG_TEXT_WORD_COUNT = 1_600;
const HELP_REQUESTED = process.argv.includes('--help') || process.argv.includes('-h');
const LIVE_ENABLED = process.env.RUN_LIVE_REACT_CACHE === '1';
const API_KEY = process.env.MODEL_API_KEY || '';
const BASE_URL = process.env.MODEL_BASE_URL || '';
const MODEL = process.env.MODEL_NAME || '';
const RUN_ID = randomBytes(8).toString('hex');
const PROMPT_CACHE_KEY = `chat-lite-react-cache-probe-${RUN_ID}`;

const SYSTEM_TEXT = [
  'You are a prompt cache probe.',
  'Call cache_probe_step exactly once and do not output any prose or other content.',
  'Use the current requested round from the newest non-system message as the round argument.',
  'Use a short plain English note for the note argument.',
].join(' ');

const SYSTEM_MESSAGE = {
  role: 'system',
  content: [
    {
      type: 'text',
      text: SYSTEM_TEXT,
      prompt_cache_breakpoint: { mode: 'explicit' },
    },
  ],
};
const SYSTEM_MESSAGE_BYTES = JSON.stringify(SYSTEM_MESSAGE);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'cache_probe_step',
      description: 'Record one numbered step of the prompt cache probe.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          round: { type: 'integer', minimum: 1, maximum: 5 },
          note: { type: 'string' },
        },
        required: ['round', 'note'],
        additionalProperties: false,
      },
    },
  },
];

const COMMON_WORDS = [
  'time', 'people', 'year', 'way', 'day', 'thing', 'man', 'world', 'life', 'hand',
  'part', 'child', 'eye', 'woman', 'place', 'work', 'week', 'case', 'point', 'home',
  'water', 'room', 'mother', 'area', 'money', 'story', 'fact', 'month', 'lot', 'right',
  'study', 'book', 'word', 'business', 'issue', 'side', 'kind', 'head', 'house', 'service',
  'friend', 'father', 'power', 'hour', 'game', 'line', 'end', 'member', 'law', 'car',
  'city', 'name', 'team', 'minute', 'idea', 'body', 'information', 'back', 'parent', 'face',
  'others', 'level', 'office', 'door', 'health', 'person', 'art', 'war', 'history', 'party',
  'result', 'change', 'morning', 'reason', 'research', 'girl', 'food', 'moment', 'air', 'teacher',
  'force', 'education', 'foot', 'boy', 'age', 'policy', 'process', 'music', 'market', 'sense',
  'nation', 'plan', 'college', 'interest', 'death', 'experience', 'effect', 'use', 'class', 'control',
];

function buildEndpoint(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /\/chat\/completions$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function buildLongText(label, requestedRound, seed) {
  const words = Array.from(
    { length: LONG_TEXT_WORD_COUNT },
    (_, index) => COMMON_WORDS[(index + seed * 17) % COMMON_WORDS.length],
  );
  return `${label}. The current requested round is ${requestedRound}. ${words.join(' ')}.`;
}

function breakpointBlock(text) {
  return {
    type: 'text',
    text,
    prompt_cache_breakpoint: { mode: 'explicit' },
  };
}

function initialMessages() {
  return [
    SYSTEM_MESSAGE,
    {
      role: 'user',
      content: [
        breakpointBlock(buildLongText('Initial deterministic user context', 1, 0)),
      ],
    },
  ];
}

function stripNonSystemBreakpoints(messages) {
  for (const message of messages) {
    if (message.role === 'system' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object') delete block.prompt_cache_breakpoint;
    }
  }
}

function countNonSystemBreakpoints(messages) {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'system' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object' && block.prompt_cache_breakpoint) count += 1;
    }
  }
  return count;
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
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`SSE data JSON parse failed: ${message}`);
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

function appendFragment(current, fragment) {
  return fragment === undefined || fragment === null ? current : current + String(fragment);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function own(object, key) {
  return object !== null
    && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key);
}

function usageMetrics(usage, round) {
  if (!usage || typeof usage !== 'object') {
    throw new Error(`Round ${round}: usage missing from streaming response`);
  }

  const input = numberOrNull(usage.prompt_tokens ?? usage.input_tokens);
  const output = numberOrNull(usage.completion_tokens ?? usage.output_tokens);
  const total = numberOrNull(usage.total_tokens);
  if (input === null) {
    throw new Error(`Round ${round}: usage is missing prompt_tokens/input_tokens`);
  }

  const promptDetails = usage.prompt_tokens_details;
  const inputDetails = usage.input_tokens_details;
  const promptCachePresent = own(promptDetails, 'cached_tokens');
  const inputCachePresent = own(inputDetails, 'cached_tokens');
  const cacheFieldPresent = promptCachePresent || inputCachePresent;
  const cached = cacheFieldPresent
    ? numberOrNull(promptCachePresent ? promptDetails.cached_tokens : inputDetails.cached_tokens)
    : null;

  const promptWritePresent = own(promptDetails, 'cache_write_tokens');
  const inputWritePresent = own(inputDetails, 'cache_write_tokens');
  const cacheWrite = promptWritePresent || inputWritePresent
    ? numberOrNull(promptWritePresent ? promptDetails.cache_write_tokens : inputDetails.cache_write_tokens)
    : null;
  const uncached = cacheFieldPresent && cached !== null ? input - cached : null;
  const cacheRate = cacheFieldPresent && cached !== null && input > 0
    ? (cached / input) * 100
    : null;

  return {
    input,
    output,
    total,
    cached,
    cacheWrite,
    cacheFieldPresent,
    uncached,
    cacheRate,
    rawUsage: usage,
  };
}

function formatValue(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

function formatPercent(value) {
  return value === null || value === undefined ? 'null' : `${value.toFixed(2)}%`;
}

function requestBody(messages) {
  return {
    model: MODEL,
    prompt_cache_key: PROMPT_CACHE_KEY,
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    messages,
    tools: TOOLS,
    tool_choice: { type: 'function', function: { name: 'cache_probe_step' } },
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128,
  };
}

async function runRound(round, endpoint, messages, previousInput) {
  assert.equal(JSON.stringify(messages[0]), SYSTEM_MESSAGE_BYTES, `Round ${round}: system message changed`);
  assert.equal(countNonSystemBreakpoints(messages), 1, `Round ${round}: expected one movable breakpoint`);

  const startedAt = performance.now();
  let firstTokenAt = null;
  let usage;
  let finishReason = null;
  let content = '';
  const callsByIndex = new Map();

  const response = await fetchRound(endpoint, JSON.stringify(requestBody(messages)), round);

  const requestId = requestIdFrom(response);
  if (!response.ok) {
    const responseBody = await response.text();
    console.error(`Round ${round}: HTTP ${response.status} requestId=${requestId}`);
    console.error(`Body (first 500 chars): ${responseBody.slice(0, 500)}`);
    throw new Error(`Round ${round}: request failed`);
  }
  if (!response.body) {
    throw new Error(`Round ${round}: response has no stream body (requestId=${requestId})`);
  }

  const markFirstToken = (fragment) => {
    if (firstTokenAt === null && fragment !== undefined && fragment !== null && String(fragment).length > 0) {
      firstTokenAt = performance.now();
    }
  };
  const parser = createSseParser((payload) => {
    if (payload?.error) {
      throw new Error(`Round ${round}: stream error ${JSON.stringify(payload.error).slice(0, 500)}`);
    }
    if (payload?.usage) usage = payload.usage;

    for (const choice of payload?.choices || []) {
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
      const delta = choice?.delta || {};
      const contentFragment = textFromPart(delta.content);
      if (contentFragment) {
        markFirstToken(contentFragment);
        content += contentFragment;
      }

      for (const callDelta of delta.tool_calls || []) {
        const index = Number.isInteger(callDelta.index) ? callDelta.index : callsByIndex.size;
        const call = callsByIndex.get(index) || {
          id: '',
          type: callDelta.type || 'function',
          function: { name: '', arguments: '' },
        };
        markFirstToken(callDelta.id ?? callDelta.function?.name ?? callDelta.function?.arguments);
        call.id = appendFragment(call.id, callDelta.id);
        if (callDelta.type) call.type = callDelta.type;
        call.function.name = appendFragment(call.function.name, callDelta.function?.name);
        call.function.arguments = appendFragment(call.function.arguments, callDelta.function?.arguments);
        callsByIndex.set(index, call);
      }
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
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
  const toolCalls = [...callsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  assert.equal(content.trim(), '', `Round ${round}: assistant returned prose instead of only a tool call`);
  assert.equal(toolCalls.length, 1, `Round ${round}: expected exactly one tool call`);
  assert.equal(toolCalls[0].type, 'function', `Round ${round}: expected a function tool call`);
  assert.equal(toolCalls[0].function.name, 'cache_probe_step', `Round ${round}: unexpected tool name`);
  assert.ok(toolCalls[0].id, `Round ${round}: tool call id is missing`);
  assert.ok(toolCalls[0].function.arguments, `Round ${round}: tool call arguments are missing`);

  const metrics = usageMetrics(usage, round);
  if (round === 1) {
    assert.ok(metrics.input > 1_024, `Round 1: input must be >1024, got ${metrics.input}`);
  } else {
    const increase = metrics.input - previousInput;
    assert.ok(increase >= 1_024, `Round ${round}: input increased by ${increase}, expected at least 1024`);
  }

  const inputDelta = previousInput === null ? null : metrics.input - previousInput;
  const cachedVsPreviousInput = previousInput !== null
    && metrics.cacheFieldPresent
    && metrics.cached !== null
    && previousInput > 0
    ? (metrics.cached / previousInput) * 100
    : null;
  const ttftMs = firstTokenAt === null ? null : firstTokenAt - startedAt;
  const totalMs = finishedAt - startedAt;
  const assistantMessage = {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls,
  };

  const result = {
    round,
    ...metrics,
    inputDelta,
    cachedVsPreviousInput,
    ttftMs,
    totalMs,
    requestId,
    finishReason,
  };
  console.log(
    `Round ${round}: requestId=${requestId} input=${metrics.input} output=${formatValue(metrics.output)}`
    + ` total=${formatValue(metrics.total)} cached=${formatValue(metrics.cached)}`
    + ` cacheField=${metrics.cacheFieldPresent} uncached=${formatValue(metrics.uncached)}`
    + ` cacheRate=${formatPercent(metrics.cacheRate)} cacheWrite=${formatValue(metrics.cacheWrite)}`
    + ` inputDelta=${formatValue(inputDelta)} cachedVsPrevInput=${formatPercent(cachedVsPreviousInput)}`
    + ` ttftMs=${formatValue(ttftMs === null ? null : Math.round(ttftMs))}`
    + ` totalMs=${Math.round(totalMs)} finishReason=${formatValue(finishReason)}`,
  );

  return { result, assistantMessage, toolCallId: toolCalls[0].id };
}

function appendRoundResult(messages, round, assistantMessage, toolCallId) {
  const stableHistory = JSON.stringify(messages, (key, value) => (
    key === 'prompt_cache_breakpoint' ? undefined : value
  ));
  stripNonSystemBreakpoints(messages);
  messages.push(assistantMessage);
  messages.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: [
      breakpointBlock(buildLongText(`Deterministic tool result after round ${round}`, round + 1, round)),
    ],
  });

  const existingHistory = messages.slice(0, -2);
  assert.equal(
    JSON.stringify(existingHistory, (key, value) => (key === 'prompt_cache_breakpoint' ? undefined : value)),
    stableHistory,
    `Round ${round}: existing message history changed while moving the breakpoint`,
  );
  assert.equal(JSON.stringify(messages[0]), SYSTEM_MESSAGE_BYTES, `Round ${round}: system message changed`);
  assert.equal(countNonSystemBreakpoints(messages), 1, `Round ${round}: movable breakpoint count is not one`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function tableRow(result) {
  return {
    round: result.round,
    input: result.input,
    output: result.output,
    total: result.total,
    cached: result.cached,
    cacheWrite: result.cacheWrite,
    cacheField: result.cacheFieldPresent,
    uncached: result.uncached,
    cacheRate: formatPercent(result.cacheRate),
    inputDelta: result.inputDelta,
    cachedVsPrevInput: formatPercent(result.cachedVsPreviousInput),
    ttftMs: result.ttftMs === null ? null : Math.round(result.ttftMs),
    totalMs: Math.round(result.totalMs),
    finishReason: result.finishReason,
  };
}

async function main() {
  if (HELP_REQUESTED) {
    console.log('Run the live ReAct cache probe with:');
    console.log("  $env:RUN_LIVE_REACT_CACHE='1'; node --env-file=.env test/test-react-prompt-cache.mjs");
    return;
  }

  if (!LIVE_ENABLED) {
    console.log('SKIP: set RUN_LIVE_REACT_CACHE=1 to run the paid live ReAct cache probe.');
    return;
  }

  const endpoint = buildEndpoint(BASE_URL);
  if (!API_KEY || !endpoint || !MODEL) {
    throw new Error('Missing MODEL_API_KEY, MODEL_BASE_URL, or MODEL_NAME');
  }

  console.log('Live ReAct prompt cache probe');
  console.log(`runId=${RUN_ID}`);
  console.log(`model=${MODEL}`);

  const messages = initialMessages();
  const results = [];
  let previousInput = null;
  for (let round = 1; round <= ROUND_COUNT; round += 1) {
    if (round > 1) await delay(REQUEST_INTERVAL_MS);
    const { result, assistantMessage, toolCallId } = await runRound(
      round,
      endpoint,
      messages,
      previousInput,
    );
    results.push(result);
    previousInput = result.input;
    if (round < ROUND_COUNT) {
      appendRoundResult(messages, round, assistantMessage, toolCallId);
    }
  }

  console.log('\nSummary');
  console.table(results.map(tableRow));
  console.log('\nBreakpoint positions by request:');
  console.log('Round 1: breakpoint 1 is on the fixed system text block; breakpoint 2 is on the initial user text block.');
  for (let round = 2; round <= ROUND_COUNT; round += 1) {
    console.log(`Round ${round}: breakpoint 1 is on the fixed system text block; breakpoint 2 is on the tool text block appended after round ${round - 1}.`);
  }
  console.log('Reminder: 断点声明不等于命中 (declaring a breakpoint does not prove a cache hit).');
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`Live ReAct cache probe failed: ${message}`);
  process.exitCode = 1;
});
