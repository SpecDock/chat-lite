import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

if (process.env.RUN_LIVE_TEXT_IMAGE !== '1') {
  console.info('text image API live probe: skip (set RUN_LIVE_TEXT_IMAGE=1 to run)');
  process.exit(0);
}

for (const key of ['TEXT_IMAGE_API_URL', 'TEXT_IMAGE_API_KEY', 'TEXT_IMAGE_MODEL']) {
  assert.ok(process.env[key], `${key} is required`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-text-image-'));
const outputPath = resolve('test/output-text-image-api.png');
const envKeys = ['DATABASE_PATH', 'DATA_DIR', 'UPLOAD_DIR', 'RAG_DATABASE_PATH', 'RAG_READ_ENABLED', 'RAG_WRITE_ENABLED', 'RAG_SHADOW_ENABLED'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let db;
let failure;

try {
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  process.env.DATA_DIR = tempDir;
  process.env.UPLOAD_DIR = join(tempDir, 'uploads');
  process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
  process.env.RAG_READ_ENABLED = 'false';
  process.env.RAG_WRITE_ENABLED = 'false';
  process.env.RAG_SHADOW_ENABLED = 'false';

  const [{ generateImageForUser }, dbModule] = await Promise.all([
    import('../src/server/modules/images/image-generation.service.ts'),
    import('../src/server/core/db.ts'),
  ]);
  db = dbModule.db;
  const userId = randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users (id,email,password_hash,email_verified_at,created_at) VALUES (?,?,?,?,?)')
    .run(userId, `${userId}@example.invalid`, 'probe', now, now);

  const startedAt = performance.now();
  const result = await generateImageForUser({
    userId,
    prompt: 'A simple small red circle centered on a plain white background. Clean test image, no text.',
  });
  const elapsedMs = performance.now() - startedAt;
  assert.match(result.markdown, /!\[[^\]]*\]\(\/api\/files\/att_/);
  const attachment = db.prepare('SELECT file_path,mime_type,size FROM attachments WHERE id=? AND user_id=?')
    .get(result.attachment.id, userId);
  assert.ok(attachment?.file_path, 'generated attachment must exist');
  const bytes = await readFile(attachment.file_path);
  assert.ok(bytes.length > 100, 'generated image must contain bytes');
  await copyFile(attachment.file_path, outputPath);
  console.info(`text image API live probe passed: model=${process.env.TEXT_IMAGE_MODEL} elapsed=${(elapsedMs / 1000).toFixed(2)}s bytes=${bytes.length} mime=${attachment.mime_type} output=${outputPath}`);
} catch (error) {
  failure = error;
} finally {
  if (db?.open) db.close();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
}

if (failure) {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
}
