import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-multi-runtime-'));
const uploadDir = join(tempDir, 'uploads');
await mkdir(uploadDir, { recursive: true });
const basePath = join(uploadDir, 'base.png');
const overlayPath = join(uploadDir, 'overlay.png');
await copyFile(resolve('test/input.png'), basePath);
await copyFile(resolve('test/input.png'), overlayPath);

const requests = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lvONLwAAAABJRU5ErkJggg==';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    requests.push(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  });
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
assert.ok(address && typeof address === 'object');

process.env.DATABASE_PATH = join(tempDir, 'app.db');
process.env.DATA_DIR = tempDir;
process.env.UPLOAD_DIR = uploadDir;
process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
process.env.RAG_READ_ENABLED = 'false';
process.env.RAG_WRITE_ENABLED = 'false';
process.env.RAG_SHADOW_ENABLED = 'false';
process.env.IMAGE_EDIT_API_URL = `http://127.0.0.1:${address.port}/v1/images/edits`;
process.env.IMAGE_EDIT_API_KEY = 'test-key';
process.env.IMAGE_EDIT_MODEL = 'gpt-image-2';
process.env.IMAGE_EDIT_RESPONSE_FORMAT = 'b64_json';
process.env.IMAGE_EDIT_SIZE = 'auto';

let db;
try {
  const [{ createDefaultToolRegistry }, { executeImageEditForUser }, dbModule] = await Promise.all([
    import('../src/server/modules/chat/engine/tool-registry.ts'),
    import('../src/server/modules/chat/tools/image-edit.tool.ts'),
    import('../src/server/core/db.ts'),
  ]);
  db = dbModule.db;
  const userId = randomUUID();
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const overlayId = `att_${randomUUID().replaceAll('-', '')}`;
  const baseId = `att_${randomUUID().replaceAll('-', '')}`;
  const otherId = `att_${randomUUID().replaceAll('-', '')}`;
  const now = new Date().toISOString();

  db.prepare('INSERT INTO users (id,email,password_hash,email_verified_at,created_at) VALUES (?,?,?,?,?)')
    .run(userId, `${userId}@example.invalid`, 'test', now, now);
  const insertConversation = db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)');
  insertConversation.run(conversationId, userId, 'current', now, now);
  insertConversation.run(otherConversationId, userId, 'other', now, now);
  const insertAttachment = db.prepare(`INSERT INTO attachments
    (id,user_id,conversation_id,message_id,original_name,file_path,public_path,mime_type,size,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertAttachment.run(overlayId, userId, conversationId, null, 'overlay.png', overlayPath, `/api/files/${overlayId}`, 'image/png', (await readFile(overlayPath)).byteLength, now);
  insertAttachment.run(baseId, userId, conversationId, null, 'base.png', basePath, `/api/files/${baseId}`, 'image/png', (await readFile(basePath)).byteLength, now);
  insertAttachment.run(otherId, userId, otherConversationId, null, 'other.png', overlayPath, `/api/files/${otherId}`, 'image/png', (await readFile(overlayPath)).byteLength, now);

  const imageEdit = createDefaultToolRegistry().get('image_edit');
  assert.ok(imageEdit);
  const result = await imageEdit.execute({
    attachmentId: '第二张图片',
    referenceAttachmentIds: ['第一张图片'],
    prompt: 'Place the full content of Image 2 in the bottom-right of Image 1.',
  }, {
    userId,
    conversationId,
    userInput: '把第一张图片放在第二张图片右下角',
    history: [],
    attachmentIds: [overlayId, baseId],
    imageCandidates: {
      current: [
        { attachmentId: overlayId, label: '当前图1', createdAt: now, sourceText: 'overlay' },
        { attachmentId: baseId, label: '当前图2', createdAt: now, sourceText: 'base' },
      ],
      historical: [],
      generated: [],
    },
    viewedImageIds: new Set(),
  });
  assert.equal(typeof result, 'string');
  assert.match(result, /1 张参考图/);
  assert.equal(requests.length, 1);
  const multipart = requests[0].toString('latin1');
  const filenames = [...multipart.matchAll(/name="image\[\]"; filename="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(filenames, ['base.png', 'overlay.png']);

  const requestCount = requests.length;
  await assert.rejects(
    executeImageEditForUser({
      userId,
      conversationId,
      prompt: 'test cross-conversation rejection',
      sourceAttachmentId: otherId,
    }),
    /图片不存在/
  );
  assert.equal(requests.length, requestCount, 'cross-conversation image must be rejected before upstream fetch');
  console.info('multi-image edit runtime sanity passed');
} finally {
  if (db?.open) db.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(tempDir, { recursive: true, force: true });
}
