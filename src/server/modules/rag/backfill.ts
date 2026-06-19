import 'dotenv/config';
import { runBackfill } from './rag.service.js';
import { ragConfig } from './rag.config.js';
import { closeRagDb } from './rag-db.js';

async function main() {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let delayMs: number | undefined;
  const userIds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--limit') {
      limit = Number(args[i + 1]);
      i += 1;
    } else if (arg === '--delay') {
      delayMs = Number(args[i + 1]);
      i += 1;
    } else if (arg === '--user') {
      const value = args[i + 1];
      if (value) userIds.push(value);
      i += 1;
    }
  }
  const cfg = ragConfig();
  console.log('[rag] starting backfill', {
    writeEnabled: cfg.writeEnabled,
    database: cfg.databasePath,
    batchSize: cfg.backfill.batchSize,
    delayMs: delayMs ?? cfg.backfill.delayMs,
    limit,
    userIds: userIds.length || 'all'
  });
  if (!cfg.writeEnabled) {
    console.warn('[rag] RAG_WRITE_ENABLED is false; aborting');
    process.exit(1);
  }
  const summary = await runBackfill({ limit, delayMs, userIds: userIds.length ? userIds : undefined });
  console.log('[rag] backfill summary', summary);
  closeRagDb();
  process.exit(0);
}

main().catch(error => {
  console.error('[rag] backfill failed:', error);
  closeRagDb();
  process.exit(1);
});