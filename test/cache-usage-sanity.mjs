import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-cache-usage-'));
const originalDatabasePath = process.env.DATABASE_PATH;
const originalDataDir = process.env.DATA_DIR;
process.env.DATABASE_PATH = join(tempDir, 'cache-usage.db');
process.env.DATA_DIR = tempDir;

const { runChatModelOnce, streamFinalResponse } = await import('../src/server/modules/chat/engine/agent-loop.ts');
const { aggregateAgentUsage } = await import('../src/server/modules/chat/engine/tool-def.ts');
const { db } = await import('../src/server/core/db.ts');

function fakeModel(chunks) {
  return {
    async stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const decision = await runChatModelOnce(fakeModel([
  { content: '', tool_call_chunks: [{ index: 0, id: 'call_1', name: 'web_search', args: '{"query":"x"}' }] },
  {
    content: '',
    usage_metadata: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_token_details: { cache_read: 0 },
    },
  },
]), []);
assert.equal(decision.ai.tool_calls.length, 1);
assert.equal(decision.events.length, 1, 'tool-call decision usage must not be dropped');
assert.equal(decision.events[0].type, 'usage');
assert.equal(decision.events[0].usage.cacheMeasuredPromptTokens, 10);
assert.equal(decision.events[0].usage.cachedTokens, 0, 'cache miss is a measured zero');

const rawUsageDecision = await runChatModelOnce(fakeModel([
  { content: 'done' },
  {
    content: '',
    response_metadata: {
      usage: {
        prompt_tokens: 20,
        completion_tokens: 3,
        total_tokens: 23,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    },
  },
]), []);
const rawUsage = rawUsageDecision.events.find(event => event.type === 'usage').usage;
assert.equal(rawUsage.cacheMeasuredPromptTokens, 20);
assert.equal(rawUsage.cachedTokens, 5);

const missingCacheDecision = await runChatModelOnce(fakeModel([
  { content: 'plain' },
  { content: '', usage_metadata: { input_tokens: 7, output_tokens: 1, total_tokens: 8 } },
]), []);
const missingCacheUsage = missingCacheDecision.events.find(event => event.type === 'usage').usage;
assert.equal(missingCacheUsage.cacheMeasuredPromptTokens, undefined);
assert.equal(missingCacheUsage.cachedTokens, undefined);

let aggregate;
aggregate = aggregateAgentUsage(aggregate, decision.events[0].usage);
aggregate = aggregateAgentUsage(aggregate, rawUsage);
aggregate = aggregateAgentUsage(aggregate, missingCacheUsage);
assert.equal(aggregate.promptTokens, 37);
assert.equal(aggregate.cacheMeasuredPromptTokens, 30, 'only measured calls contribute to cache denominator');
assert.equal(aggregate.cachedTokens, 5);

const finalEvents = [];
for await (const event of streamFinalResponse(fakeModel([
  { content: 'final' },
  {
    content: '',
    usage_metadata: {
      input_tokens: 12,
      output_tokens: 1,
      total_tokens: 13,
      input_token_details: { cache_read: 4 },
    },
  },
]), [])) {
  finalEvents.push(event);
}
const finalUsage = finalEvents.find(event => event.type === 'usage').usage;
assert.equal(finalUsage.cacheMeasuredPromptTokens, 12);
assert.equal(finalUsage.cachedTokens, 4, 'final-call usage is yielded');

db.close();
if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
else process.env.DATABASE_PATH = originalDatabasePath;
if (originalDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = originalDataDir;
await rm(tempDir, { recursive: true, force: true });

console.info('cache usage sanity passed');
