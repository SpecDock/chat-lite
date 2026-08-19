import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateAttachmentWorkspaces } from './workspace-migration.js';

const root = process.cwd();
export const dataDir = process.env.DATA_DIR || join(root, 'data');
export const uploadDir = process.env.UPLOAD_DIR || join(dataDir, 'uploads');
export const workDir = join(dataDir, 'work');
mkdirSync(uploadDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH || join(dataDir, 'app.db');
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function migrateConversationSidebarColumns() {
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get();
  if (!tableExists) return;
  const columns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'pinned_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN pinned_at TEXT');
  }
  if (!columns.some(column => column.name === 'title_manually_set')) {
    db.exec('ALTER TABLE conversations ADD COLUMN title_manually_set INTEGER NOT NULL DEFAULT 0');
  }
}

migrateConversationSidebarColumns();

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = [
  process.env.SCHEMA_PATH,
  join(root, 'src/server/schema.sql'),
  join(here, 'schema.sql'),
  join(root, 'dist-server/schema.sql')
].filter(Boolean).find((path) => existsSync(path!));
if (!schemaPath) throw new Error('找不到数据库 schema.sql');
db.exec(readFileSync(schemaPath, 'utf8'));

const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
if (!userColumns.some(column => column.name === 'avatar_attachment_id')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_attachment_id TEXT');
}

function tableHasForeignKeys(table: string) {
  return (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown[]).length > 0;
}

function tableColumns(table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
}

function migrateUsageTablesToAppendOnly() {
  const tokenExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage'").get();
  const imageExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_usage'").get();
  if (!tokenExists && !imageExists) return;
  if (!tableHasForeignKeys('token_usage') && !tableHasForeignKeys('image_usage')) return;
  const tokenColumns = tokenExists ? tableColumns('token_usage') : new Set<string>();

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      if (tokenExists && tableHasForeignKeys('token_usage')) {
        db.exec(`
          CREATE TABLE token_usage_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            model TEXT,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cache_measured_prompt_tokens INTEGER,
            cached_tokens INTEGER,
            created_at TEXT NOT NULL
          );
          INSERT INTO token_usage_new (id,user_id,conversation_id,message_id,model,prompt_tokens,completion_tokens,total_tokens,cache_measured_prompt_tokens,cached_tokens,created_at)
            SELECT id,user_id,conversation_id,message_id,model,prompt_tokens,completion_tokens,total_tokens,
              ${tokenColumns.has('cache_measured_prompt_tokens') ? 'cache_measured_prompt_tokens' : 'NULL'},
              ${tokenColumns.has('cached_tokens') ? 'cached_tokens' : 'NULL'},created_at FROM token_usage;
          DROP TABLE token_usage;
          ALTER TABLE token_usage_new RENAME TO token_usage;
          CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_token_usage_message ON token_usage(message_id);
        `);
      }

      if (imageExists && tableHasForeignKeys('image_usage')) {
        db.exec(`
          CREATE TABLE image_usage_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            image_generation_id TEXT NOT NULL,
            model TEXT,
            cost_units REAL NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
          );
          INSERT INTO image_usage_new (id,user_id,image_generation_id,model,cost_units,created_at)
            SELECT id,user_id,image_generation_id,model,cost_units,created_at FROM image_usage;
          DROP TABLE image_usage;
          ALTER TABLE image_usage_new RENAME TO image_usage;
          CREATE INDEX IF NOT EXISTS idx_image_usage_user_created ON image_usage(user_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_image_usage_generation ON image_usage(image_generation_id);
        `);
      }
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

migrateUsageTablesToAppendOnly();

function ensureUsageCacheColumns() {
  const columns = tableColumns('token_usage');
  if (!columns.has('cache_measured_prompt_tokens')) {
    db.exec('ALTER TABLE token_usage ADD COLUMN cache_measured_prompt_tokens INTEGER');
  }
  if (!columns.has('cached_tokens')) {
    db.exec('ALTER TABLE token_usage ADD COLUMN cached_tokens INTEGER');
  }
}

ensureUsageCacheColumns();
migrateAttachmentWorkspaces(db, dataDir);

export const now = () => new Date().toISOString();

export function row<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
