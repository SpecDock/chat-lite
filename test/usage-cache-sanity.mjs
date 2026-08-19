import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-usage-cache-'));
const databasePath = join(tempDir, 'legacy.db');
const legacy = new Database(databasePath);
legacy.pragma('foreign_keys = ON');
legacy.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    avatar_attachment_id TEXT, email_verified_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, model TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  INSERT INTO users (id,email,password_hash,created_at) VALUES ('user-cache','cache@example.test','hash','2024-01-01T00:00:00.000Z');
  INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES ('conv-cache','user-cache','cache','2024-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z');
  INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES ('msg-old','user-cache','conv-cache','assistant','old','completed','2024-01-01T00:00:00.000Z');
  INSERT INTO token_usage (user_id,conversation_id,message_id,model,prompt_tokens,completion_tokens,total_tokens,created_at)
    VALUES ('user-cache','conv-cache','msg-old','model',8,2,10,'2024-01-01T00:00:00.000Z');
`);
legacy.close();

const originalDatabasePath = process.env.DATABASE_PATH;
const originalDataDir = process.env.DATA_DIR;
process.env.DATABASE_PATH = databasePath;
process.env.DATA_DIR = tempDir;

let openedDb;
try {
  const dbModule = await import('../src/server/core/db.ts');
  const service = await import('../src/server/modules/usage/usage.service.ts');
  openedDb = dbModule.db;

  assert.equal(openedDb.prepare('PRAGMA foreign_key_list(token_usage)').all().length, 0, 'usage table becomes append-only');
  const oldRow = openedDb.prepare('SELECT cache_measured_prompt_tokens AS measured, cached_tokens AS cached FROM token_usage WHERE message_id=?').get('msg-old');
  assert.deepEqual(oldRow, { measured: null, cached: null }, 'legacy usage remains NULL');

  service.recordTokenUsage({
    userId: 'user-cache', conversationId: 'conv-cache', messageId: 'msg-miss', model: 'model',
    promptTokens: 12, completionTokens: 8, totalTokens: 20,
    cacheMeasuredPromptTokens: 12, cachedTokens: 0,
  });
  service.recordTokenUsage({
    userId: 'user-cache', conversationId: 'conv-cache', messageId: 'msg-hit', model: 'model',
    promptTokens: 20, completionTokens: 10, totalTokens: 30,
    cacheMeasuredPromptTokens: 20, cachedTokens: 8,
  });
  openedDb.prepare("UPDATE token_usage SET created_at='2024-01-02T00:00:00.000Z' WHERE message_id='msg-miss'").run();
  openedDb.prepare("UPDATE token_usage SET created_at='2024-01-03T00:00:00.000Z' WHERE message_id='msg-hit'").run();

  const missRow = openedDb.prepare('SELECT cache_measured_prompt_tokens AS measured, cached_tokens AS cached FROM token_usage WHERE message_id=?').get('msg-miss');
  assert.deepEqual(missRow, { measured: 12, cached: 0 }, 'new cache miss stores measured zero');

  const usage = service.getUsage('user-cache');
  assert.equal(usage.token.total, 60);
  assert.equal(usage.token.cachedTotal, 8);
  const oldDay = usage.token.days.find(day => day.date === '2024-01-01');
  const missDay = usage.token.days.find(day => day.date === '2024-01-02');
  const hitDay = usage.token.days.find(day => day.date === '2024-01-03');
  assert.equal(oldDay.cacheRate, null, 'legacy all-NULL day has no cache rate');
  assert.equal(oldDay.cachedValue, 0);
  assert.equal(missDay.cacheRate, 0, 'measured cache miss day has zero rate');
  assert.equal(missDay.cachedValue, 0);
  assert.equal(hitDay.cacheRate, 40);
  assert.equal(hitDay.cachedValue, 8);
} finally {
  openedDb?.close();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  await rm(tempDir, { recursive: true, force: true });
}

console.info('usage cache sanity passed');
