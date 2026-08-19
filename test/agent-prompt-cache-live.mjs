import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (process.env.RUN_LIVE_PROMPT_CACHE !== '1') {
  console.info('agent prompt cache live probe: skip (set RUN_LIVE_PROMPT_CACHE=1 to run)');
  process.exit(0);
}

const ENV_KEYS = [
  'DATABASE_PATH',
  'DATA_DIR',
  'UPLOAD_DIR',
  'RAG_DATABASE_PATH',
  'RAG_READ_ENABLED',
  'RAG_WRITE_ENABLED',
  'RAG_SHADOW_ENABLED',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-agent-prompt-cache-'));
let db;

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function printableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'null';
}

async function runProbe(runAgentLoop, aggregateAgentUsage, sharedInput, runNumber) {
  let deltaText = '';
  let deltaEvents = 0;
  let thinkEvents = 0;
  let aggregate;
  const usageEvents = [];

  for await (const event of runAgentLoop({ ...sharedInput, requestId: randomUUID() })) {
    if (event.type === 'think') {
      thinkEvents += 1;
    } else if (event.type === 'delta') {
      deltaEvents += 1;
      deltaText += event.text;
    } else if (event.type === 'usage') {
      usageEvents.push(event.usage);
      aggregate = aggregateAgentUsage(aggregate, event.usage);
    }
  }

  assert.ok(deltaText.trim().length > 0, `run ${runNumber} must produce a final delta`);
  assert.ok(usageEvents.length >= 2, `run ${runNumber} must yield decision and final usage`);
  assert.ok(
    typeof aggregate?.cacheMeasuredPromptTokens === 'number' && aggregate.cacheMeasuredPromptTokens > 0,
    `run ${runNumber} must measure prompt cache tokens`,
  );
  assert.ok(
    typeof aggregate?.cachedTokens === 'number' && aggregate.cachedTokens >= 0,
    `run ${runNumber} must carry cached tokens`,
  );

  console.info(`run=${runNumber} think_events=${thinkEvents} delta_events=${deltaEvents} usage_events=${usageEvents.length}`);
  usageEvents.forEach((usage, index) => {
    console.info(
      `run=${runNumber} usage=${index + 1} prompt=${printableNumber(usage.promptTokens)}`
      + ` completion=${printableNumber(usage.completionTokens)}`
      + ` total=${printableNumber(usage.totalTokens)}`
      + ` cacheMeasured=${printableNumber(usage.cacheMeasuredPromptTokens)}`
      + ` cached=${printableNumber(usage.cachedTokens)}`,
    );
  });

  const cacheObserved = aggregate.cachedTokens > 0;
  const cacheRate = aggregate.cachedTokens * 100 / aggregate.cacheMeasuredPromptTokens;
  console.info(
    `run=${runNumber} aggregate_prompt=${printableNumber(aggregate.promptTokens)}`
    + ` aggregate_completion=${printableNumber(aggregate.completionTokens)}`
    + ` aggregate_total=${printableNumber(aggregate.totalTokens)}`
    + ` aggregate_cacheMeasured=${aggregate.cacheMeasuredPromptTokens}`
    + ` aggregate_cached=${aggregate.cachedTokens}`,
  );
  console.info(`run=${runNumber} CACHE_OBSERVED=${cacheObserved ? 'yes' : 'no'} cache_rate=${cacheRate.toFixed(1)}%`);

  return aggregate;
}

try {
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  process.env.DATA_DIR = tempDir;
  process.env.UPLOAD_DIR = join(tempDir, 'uploads');
  process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
  process.env.RAG_READ_ENABLED = 'false';
  process.env.RAG_WRITE_ENABLED = 'false';
  process.env.RAG_SHADOW_ENABLED = 'false';

  const [{ runAgentLoop }, { aggregateAgentUsage }, dbModule] = await Promise.all([
    import('../src/server/modules/chat/engine/agent-loop.ts'),
    import('../src/server/modules/chat/engine/tool-def.ts'),
    import('../src/server/core/db.ts'),
  ]);
  db = dbModule.db;

  const sharedInput = {
    userId: randomUUID(),
    conversationId: randomUUID(),
    history: [],
    attachmentIds: [],
    userInput: '只用一句很短的中文回复：你好。不要联网，不要调用工具。',
  };

  await runProbe(runAgentLoop, aggregateAgentUsage, sharedInput, 1);
  await runProbe(runAgentLoop, aggregateAgentUsage, sharedInput, 2);
} finally {
  if (db?.open) db.close();
  restoreEnvironment();
  await rm(tempDir, { recursive: true, force: true });
}
