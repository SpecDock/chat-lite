PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_attachment_id TEXT,
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (avatar_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming','completed','interrupted','error')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(user_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  original_name TEXT,
  file_path TEXT NOT NULL,
  public_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS image_generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  result_attachment_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (result_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_image_generations_user ON image_generations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_message ON token_usage(message_id);

CREATE TABLE IF NOT EXISTS image_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  image_generation_id TEXT NOT NULL,
  model TEXT,
  cost_units REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_usage_user_created ON image_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_usage_generation ON image_usage(image_generation_id);
