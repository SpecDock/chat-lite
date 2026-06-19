import { join } from 'node:path';

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function floatEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function dataRoot() {
  return process.env.DATA_DIR || join(process.cwd(), 'data');
}

export type RagConfig = {
  writeEnabled: boolean;
  readEnabled: boolean;
  shadowEnabled: boolean;
  topK: number;
  currentConversationBoost: number;
  contentMaxChars: number;
  chunkEnabled: boolean;
  chunkMaxChars: number;
  databasePath: string;
  embedding: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dimensions: number;
  };
  chunker: {
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature: number;
  };
  backfill: {
    batchSize: number;
    delayMs: number;
  };
};

let cached: RagConfig | undefined;

export function ragConfig(): RagConfig {
  if (cached) return cached;
  cached = {
    writeEnabled: boolEnv('RAG_WRITE_ENABLED', false),
    readEnabled: boolEnv('RAG_READ_ENABLED', false),
    shadowEnabled: boolEnv('RAG_SHADOW_ENABLED', false),
    topK: intEnv('RAG_TOP_K', 3),
    currentConversationBoost: floatEnv('RAG_CURRENT_CONVERSATION_BOOST', 0.15),
    contentMaxChars: intEnv('RAG_CONTENT_MAX_CHARS', 1200),
    chunkEnabled: boolEnv('RAG_CHUNK_ENABLED', true),
    chunkMaxChars: intEnv('RAG_CHUNK_MAX_CHARS', 1200),
    databasePath: process.env.RAG_DATABASE_PATH || join(dataRoot(), 'rag.db'),
    embedding: {
      apiKey: process.env.EMBEDDING_API_KEY || '',
      baseUrl: process.env.EMBEDDING_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimensions: intEnv('EMBEDDING_DIMENSIONS', 1536)
    },
    chunker: {
      apiKey: process.env.RAG_CHUNK_MODEL_API_KEY || '',
      baseUrl: process.env.RAG_CHUNK_MODEL_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.RAG_CHUNK_MODEL_NAME || '',
      temperature: floatEnv('RAG_CHUNK_MODEL_TEMPERATURE', 0.1)
    },
    backfill: {
      batchSize: intEnv('RAG_BACKFILL_BATCH_SIZE', 50),
      delayMs: intEnv('RAG_BACKFILL_DELAY_MS', 1000)
    }
  };
  return cached;
}

export function ragReadActive(): boolean {
  const cfg = ragConfig();
  return cfg.readEnabled || cfg.shadowEnabled;
}
