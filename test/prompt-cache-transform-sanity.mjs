import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import {
  createPromptCacheFetch,
  transformPromptCacheBody,
} from '../src/server/modules/chat/engine/prompt-cache.ts';

const tools = [
  { type: 'function', function: { name: 'first', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'second', parameters: { type: 'object' } } },
];

function bodyWith(role = 'system', rag = 'rag-a', currentContent = 'tail') {
  return {
    model: 'cache-model',
    messages: [
      { role, content: [{ type: 'text', text: 'stable-system' }, { type: 'text', text: rag }] },
      { role: 'assistant', content: 'history' },
      { role: 'user', content: currentContent },
    ],
    tools,
    tool_choice: 'none',
    stream: true,
  };
}

const original = bodyWith();
const snapshot = structuredClone(original);
const transformed = transformPromptCacheBody(original, 2);
assert.deepEqual(original, snapshot, 'transform must not mutate the source body');
assert.deepEqual(transformed.messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
assert.equal(transformed.messages[0].content[1].prompt_cache_breakpoint, undefined, 'RAG block has no breakpoint');
assert.deepEqual(transformed.messages[2].content, [
  { type: 'text', text: 'tail', prompt_cache_breakpoint: { mode: 'explicit' } },
]);
assert.deepEqual(transformed.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
assert.match(transformed.prompt_cache_key, /^chat-lite-[a-f0-9]{24}$/);

const developer = transformPromptCacheBody(bodyWith('developer'), 2);
assert.deepEqual(developer.messages[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });

const changedRag = transformPromptCacheBody(bodyWith('system', 'rag-b'), 2);
assert.equal(changedRag.prompt_cache_key, transformed.prompt_cache_key, 'RAG must not affect the cache key');
assert.equal(transformPromptCacheBody(bodyWith(), 2).prompt_cache_key, transformed.prompt_cache_key, 'same stable inputs produce the same key');

const reorderedToolsBody = bodyWith();
reorderedToolsBody.tools = [...tools].reverse();
assert.notEqual(transformPromptCacheBody(reorderedToolsBody, 2).prompt_cache_key, transformed.prompt_cache_key, 'tool array order affects the cache key');

const imageBody = bodyWith('system', 'rag-a', [
  { type: 'text', text: 'look at this image' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
]);
const imageTransformed = transformPromptCacheBody(imageBody, 2);
assert.equal(imageTransformed.messages[2].content[0].prompt_cache_breakpoint, undefined);
assert.deepEqual(imageTransformed.messages[2].content[1].prompt_cache_breakpoint, { mode: 'explicit' });

const requestBody = JSON.stringify(bodyWith());
const fallbackCalls = [];
const fallbackFetch = async (_input, init) => {
  fallbackCalls.push(JSON.parse(init.body));
  if (fallbackCalls.length === 1) {
    return new Response(JSON.stringify({ error: { message: 'Unknown parameter: prompt_cache_options' } }), { status: 400 });
  }
  return new Response('ok', { status: 200 });
};
const originalWarn = console.warn;
try {
  console.warn = () => undefined;
  const wrapped = createPromptCacheFetch(2, fallbackFetch);
  assert.equal((await wrapped('https://example.test/v1/chat/completions', { method: 'POST', body: requestBody })).status, 200);
  assert.equal((await wrapped('https://example.test/v1/chat/completions', { method: 'POST', body: requestBody })).status, 200);
} finally {
  console.warn = originalWarn;
}
assert.equal(fallbackCalls.length, 3, 'unsupported cache fields retry once and disable later transforms');
assert.ok(fallbackCalls[0].prompt_cache_key);
assert.equal(fallbackCalls[1].prompt_cache_key, undefined);
assert.equal(fallbackCalls[2].prompt_cache_key, undefined);

let ordinaryCalls = 0;
const ordinaryFetch = async () => {
  ordinaryCalls += 1;
  return new Response(JSON.stringify({ error: { message: 'ordinary bad request' } }), { status: 400 });
};
const ordinaryResponse = await createPromptCacheFetch(2, ordinaryFetch)(
  'https://example.test/v1/chat/completions',
  { method: 'POST', body: requestBody },
);
assert.equal(ordinaryResponse.status, 400);
assert.equal(ordinaryCalls, 1, 'ordinary 400 must not retry');

let abortCalls = 0;
const abortFetch = async () => {
  abortCalls += 1;
  throw new DOMException('aborted', 'AbortError');
};
await assert.rejects(
  createPromptCacheFetch(2, abortFetch)('https://example.test/v1/chat/completions', { method: 'POST', body: requestBody }),
  error => error?.name === 'AbortError',
);
assert.equal(abortCalls, 1, 'abort must not retry');

for (const [label, invalidBody, invalidIndex] of [
  ['invalid user index', bodyWith(), 99],
  ['invalid system shape', { ...bodyWith(), messages: [{ role: 'system', content: 'not-blocks' }, ...bodyWith().messages.slice(1)] }, 2],
]) {
  const invalidCalls = [];
  const invalidWarnings = [];
  const invalidFetch = async (_input, init) => {
    invalidCalls.push(init.body);
    return new Response('ok', { status: 200 });
  };
  const savedWarn = console.warn;
  try {
    console.warn = (...args) => invalidWarnings.push(args);
    const response = await createPromptCacheFetch(invalidIndex, invalidFetch)(
      'https://example.test/v1/chat/completions',
      { method: 'POST', body: JSON.stringify(invalidBody) },
    );
    assert.equal(response.status, 200, `${label} must fail open`);
  } finally {
    console.warn = savedWarn;
  }
  assert.equal(invalidCalls.length, 1, `${label} sends the original request once`);
  assert.deepEqual(JSON.parse(invalidCalls[0]), invalidBody, `${label} preserves the original body`);
  assert.equal(invalidWarnings.length, 1, `${label} emits one safe warning`);
}

const wireTools = [
  {
    type: 'function',
    function: {
      name: 'wire_first',
      description: 'First stable dummy tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wire_second',
      description: 'Second stable dummy tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];
const wireMessages = [
  new SystemMessage({ content: [
    { type: 'text', text: 'wire-stable-system' },
    { type: 'text', text: 'wire-dynamic-rag' },
  ] }),
  new HumanMessage('history-user'),
  new AIMessage('history-assistant'),
  new HumanMessage({ content: [
    { type: 'text', text: 'wire-current-user' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }),
];
let capturedWireBody;
const sseBody = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"wire-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"wire-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');
const wireFetch = async (_input, init) => {
  capturedWireBody = JSON.parse(init.body);
  return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const wireModel = new ChatOpenAI({
  model: 'wire-model',
  apiKey: 'test-key',
  maxRetries: 0,
  configuration: {
    baseURL: 'https://example.test/v1',
    fetch: createPromptCacheFetch(3, wireFetch),
  },
});
const wireStream = await wireModel.bindTools(wireTools, { tool_choice: 'none' }).stream(wireMessages);
for await (const _chunk of wireStream) {
  // Consume the real LangChain stream through the fake transport.
}

assert.ok(capturedWireBody, 'fake fetch captures the final Chat Completions wire body');
const wireStableMessage = capturedWireBody.messages.find(message => message.role === 'system' || message.role === 'developer');
assert.ok(wireStableMessage, 'wire body keeps a system/developer message');
assert.deepEqual(wireStableMessage.content[0].prompt_cache_breakpoint, { mode: 'explicit' });
assert.equal(wireStableMessage.content[1].prompt_cache_breakpoint, undefined, 'wire RAG block is outside the first breakpoint');
assert.deepEqual(capturedWireBody.messages[3].content.at(-1).prompt_cache_breakpoint, { mode: 'explicit' });
const breakpointCount = (JSON.stringify(capturedWireBody).match(/prompt_cache_breakpoint/g) || []).length;
assert.equal(breakpointCount, 2, 'wire body contains exactly two breakpoints');
assert.deepEqual(capturedWireBody.tools.map(tool => tool.function.name), ['wire_first', 'wire_second']);
assert.match(capturedWireBody.prompt_cache_key, /^chat-lite-[a-f0-9]{24}$/);
assert.deepEqual(capturedWireBody.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
assert.equal(JSON.stringify(capturedWireBody).includes('currentUserMessageIndex'), false, 'wire body has no internal index sentinel');
assert.equal(JSON.stringify(capturedWireBody).includes('__chat_lite_current_user__'), false, 'wire body has no current-user sentinel');

console.info('prompt cache transform sanity passed');
