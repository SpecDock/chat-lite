import assert from 'node:assert/strict';
import {
  abortableSleep,
  classifyModelError,
  createEmptyResponseError,
  isPartialFinalStreamError,
  logModelAttempt,
  modelMaxAttempts,
  retryDelayMs,
  safeCauseCodes,
} from '../src/server/modules/chat/engine/model-retry.ts';
import { runChatModelOnce, streamFinalResponse } from '../src/server/modules/chat/engine/agent-loop.ts';

function retryable(error) {
  return classifyModelError(error).retryable;
}

assert.equal(retryable(new Error('outer', { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) })), true);
assert.equal(retryable(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), true);
assert.equal(retryable(Object.assign(new Error('server error'), { status: 500 })), true);
for (const message of ['authentication failed', 'invalid request']) {
  const classified = classifyModelError(Object.assign(new Error(message), { status: 500 }));
  assert.equal(classified.kind, 'server');
  assert.equal(classified.retryable, true);
}

const shortRateLimit = classifyModelError(Object.assign(new Error('rate limited'), {
  status: 429,
  headers: { 'retry-after': '2' }
}));
assert.equal(shortRateLimit.retryable, true);
assert.equal(shortRateLimit.retryAfterMs, 2000);

const millisecondRateLimit = classifyModelError(Object.assign(new Error('rate limited'), {
  statusCode: 429,
  response: { headers: { 'retry-after-ms': '750' } }
}));
assert.equal(millisecondRateLimit.retryable, true);
assert.equal(millisecondRateLimit.retryAfterMs, 750);

assert.equal(retryable(Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '6' } })), false);
assert.equal(retryable(Object.assign(new Error('insufficient_quota'), { status: 429, code: 'insufficient_quota' })), false);
const nestedQuota = classifyModelError({
  response: { status: 429, data: { error: { code: 'insufficient_quota', message: 'provider body' } } }
});
assert.equal(nestedQuota.kind, 'quota');
assert.equal(nestedQuota.retryable, false);
for (const [retryAfterMs, expected] of [[0, true], [5000, true], [5001, false]]) {
  const classified = classifyModelError({ status: 429, headers: { 'retry-after-ms': String(retryAfterMs) } });
  assert.equal(classified.retryable, expected, `Retry-After ${retryAfterMs}`);
  assert.equal(retryDelayMs(classified), expected ? retryAfterMs : undefined, `Retry delay ${retryAfterMs}`);
}
for (const status of [400, 401, 422]) {
  assert.equal(retryable(Object.assign(new Error(`HTTP ${status}`), { status })), false);
}

for (const code of ['ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_ABORTED']) {
  assert.equal(retryable(Object.assign(new Error('transient'), { code })), true, code);
}
assert.equal(classifyModelError(new Error('未配置模型 API Key：请设置 MODEL_API_KEY')).kind, 'auth');

const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
assert.equal(retryable(abortError), false);
const classifiedAbortController = new AbortController();
classifiedAbortController.abort();
assert.equal(classifyModelError(new Error('anything'), classifiedAbortController.signal).retryable, false);
assert.equal(retryable(createEmptyResponseError()), true);

const providerBody = 'provider secret user body 87d9a7';
const safeClassification = classifyModelError(new Error(providerBody));
assert.equal(safeClassification.safeMessage.includes(providerBody), false);
assert.deepEqual(safeCauseCodes(['ECONNRESET', 'insufficient_quota', 'A', 'ERR_STREAM_PREMATURE_CLOSE']), ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE']);
const originalWarn = console.warn;
let loggedPayload;
try {
  console.warn = (_label, payload) => { loggedPayload = payload; };
  logModelAttempt({
    callId: 'call', conversationId: 'conv', phase: 'final', recursion: 0,
    attempt: 1, maxAttempts: 2, model: 'model', outcome: 'failed',
    sawText: false, committedText: false, sawToolDelta: false, elapsedMs: 1,
    errorKind: 'server', errorName: providerBody, causeCodes: ['ECONNRESET', providerBody],
    errorMessage: providerBody
  });
} finally {
  console.warn = originalWarn;
}
assert.equal(JSON.stringify(loggedPayload).includes(providerBody), false);
assert.deepEqual(loggedPayload.causeCodes, ['ECONNRESET']);

const originalAttempts = process.env.MODEL_MAX_ATTEMPTS;
try {
  delete process.env.MODEL_MAX_ATTEMPTS;
  assert.equal(modelMaxAttempts(), 2);
  process.env.MODEL_MAX_ATTEMPTS = '';
  assert.equal(modelMaxAttempts(), 2);
  process.env.MODEL_MAX_ATTEMPTS = '0';
  assert.equal(modelMaxAttempts(), 1);
  process.env.MODEL_MAX_ATTEMPTS = '99';
  assert.equal(modelMaxAttempts(), 3);
  process.env.MODEL_MAX_ATTEMPTS = 'invalid';
  assert.equal(modelMaxAttempts(), 2);
} finally {
  if (originalAttempts === undefined) delete process.env.MODEL_MAX_ATTEMPTS;
  else process.env.MODEL_MAX_ATTEMPTS = originalAttempts;
}

const controller = new AbortController();
const sleeping = abortableSleep(10_000, controller.signal);
controller.abort();
await assert.rejects(sleeping, error => error?.name === 'AbortError');

function fakeModel(chunks, terminalError) {
  return {
    async stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
        if (terminalError) throw terminalError;
      })();
    }
  };
}

await assert.rejects(
  runChatModelOnce(fakeModel([
    { content: '', tool_call_chunks: [{ index: 0, id: 'call_1', name: 'web_search', args: '{"query":"x"}' }] }
  ], Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })), []),
  error => error?.code === 'ECONNRESET'
);

const whitespaceEvents = [];
await assert.rejects(async () => {
  for await (const event of streamFinalResponse(fakeModel([
    { content: '   ' },
    { content: '', usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
  ], Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })), [])) {
    whitespaceEvents.push(event);
  }
}, error => error?.code === 'ECONNRESET');
assert.deepEqual(whitespaceEvents, []);

const partialEvents = [];
await assert.rejects(async () => {
  for await (const event of streamFinalResponse(fakeModel([
    { content: 'A' }
  ], Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })), [])) {
    partialEvents.push(event);
  }
}, error => isPartialFinalStreamError(error));
assert.deepEqual(partialEvents, [{ type: 'delta', text: 'A' }]);

await assert.rejects(async () => {
  for await (const _event of streamFinalResponse(fakeModel([], undefined), [])) {
    // no-op
  }
}, error => error?.code === 'EMPTY_RESPONSE');

console.log('model retry sanity: ok');
