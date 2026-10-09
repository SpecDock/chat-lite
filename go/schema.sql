CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_attachment_id TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email_purpose ON email_codes(email, purpose);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pinned_at TEXT,
  title_manually_set BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_user_pinned_updated ON conversations(user_id, pinned_at DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_context_states (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL DEFAULT '',
  summary_token_estimate INTEGER NOT NULL DEFAULT 0,
  summarized_through_created_at TEXT,
  summarized_through_message_id TEXT,
  last_user_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_context_states_user_id ON conversation_context_states(user_id);

CREATE TABLE IF NOT EXISTS conversation_context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  covered_message_id TEXT NOT NULL,
  covered_message_created_at TEXT NOT NULL,
  context_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'current', 'superseded', 'invalid')),
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_conversation_context_snapshots_owner
  ON conversation_context_snapshots(conversation_id, user_id, covered_message_created_at, covered_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_context_snapshots_current
  ON conversation_context_snapshots(conversation_id, user_id)
  WHERE status = 'current';

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming','completed','interrupted','error')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(user_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_search_documents (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  search_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_search_documents_user_created
  ON message_search_documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_search_trgm
  ON message_search_documents USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  original_name TEXT,
  file_path TEXT NOT NULL,
  public_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC);

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_avatar_attachment_id_fkey;
ALTER TABLE users
  ADD CONSTRAINT users_avatar_attachment_id_fkey
  FOREIGN KEY (avatar_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS image_generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  result_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_generations_user ON image_generations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS token_usage (
  id BIGSERIAL PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_message ON token_usage(message_id);

CREATE TABLE IF NOT EXISTS image_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  image_generation_id TEXT NOT NULL,
  model TEXT,
  cost_units DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_usage_user_created ON image_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_usage_generation ON image_usage(image_generation_id);

CREATE TABLE IF NOT EXISTS studio_images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  quality TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'vivid',
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error TEXT,
  duration_ms INTEGER,
  file_path TEXT,
  mime_type TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_images_user_created ON studio_images(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_images_user_running ON studio_images(user_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS studio_image_references (
  id TEXT PRIMARY KEY,
  studio_image_id TEXT NOT NULL REFERENCES studio_images(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_image_references_image ON studio_image_references(studio_image_id, sort_order);

CREATE TABLE IF NOT EXISTS rag_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  parent_text TEXT,
  chunk_type TEXT NOT NULL DEFAULT 'text',
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  embedded_at TEXT,
  embedding_dim INTEGER,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  last_injected_at TEXT,
  content_hash TEXT,
  embedding vector(1536)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_items_conversation_content_hash
  ON rag_items(conversation_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_rag_items_conversation ON rag_items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_rag_items_chunk_trgm
  ON rag_items USING gin (chunk_text gin_trgm_ops);
