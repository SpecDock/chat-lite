import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const toolRegistrySource = await readFile(new URL('../src/server/modules/chat/engine/tool-registry.ts', import.meta.url), 'utf8');
const imageServiceSource = await readFile(new URL('../src/server/modules/images/image-generation.service.ts', import.meta.url), 'utf8');
const agentSource = await readFile(new URL('../src/server/modules/chat/engine/agent-loop.ts', import.meta.url), 'utf8');

assert.match(toolRegistrySource, /referenceAttachmentIds:\s*z\.array/);
assert.match(toolRegistrySource, /第\$\{chinese\}张图片/);
assert.match(toolRegistrySource, /sourceAttachmentId:\s*source\.attachmentId/);
assert.match(toolRegistrySource, /referenceAttachmentIds,/);
assert.match(imageServiceSource, /sources\.length > 1 \? 'image\[\]' : 'image'/);
assert.match(imageServiceSource, /当前 MiniMax 图生图接口未验证多参考图/);
assert.match(imageServiceSource, /references\.length > 3/);
assert.match(agentSource, /referenceAttachmentIds 放参考图/);
assert.match(agentSource, /counts\.total = Math\.max\(0, counts\.total - 1\)/);
console.info('multi-image edit static sanity passed');

if (process.env.RUN_LIVE_MULTI_IMAGE_EDIT === '1') {
  const required = ['MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME', 'IMAGE_EDIT_API_KEY', 'IMAGE_EDIT_API_URL', 'IMAGE_EDIT_MODEL'];
  for (const key of required) assert.ok(process.env[key], `${key} is required for live multi-image probe`);

  const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-multi-image-'));
  const uploadDir = join(tempDir, 'uploads');
  const outputPath = resolve('test/output-agent-multi-image.png');
  const envKeys = ['DATABASE_PATH', 'DATA_DIR', 'UPLOAD_DIR', 'RAG_DATABASE_PATH', 'RAG_READ_ENABLED', 'RAG_WRITE_ENABLED', 'RAG_SHADOW_ENABLED'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let db;
  let restoreRegistry;

  try {
    await mkdir(uploadDir, { recursive: true });
    process.env.DATABASE_PATH = join(tempDir, 'app.db');
    process.env.DATA_DIR = tempDir;
    process.env.UPLOAD_DIR = uploadDir;
    process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
    process.env.RAG_READ_ENABLED = 'false';
    process.env.RAG_WRITE_ENABLED = 'false';
    process.env.RAG_SHADOW_ENABLED = 'false';

    const overlayPath = join(uploadDir, 'overlay.png');
    const basePath = join(uploadDir, 'base.png');
    // Keep the live probe self-contained: the repository has one tracked PNG.
    // Using it twice still verifies Agent selection, candidate resolution,
    // multipart image[] ordering, conversation scoping and provider acceptance.
    await copyFile(resolve('test/input.png'), overlayPath);
    await copyFile(resolve('test/input.png'), basePath);

    const [registryModule, dbModule] = await Promise.all([
      import('../src/server/modules/chat/engine/tool-registry.ts'),
      import('../src/server/core/db.ts'),
    ]);
    db = dbModule.db;

    const capturedArgs = [];
    const originalGet = registryModule.ToolRegistry.prototype.get;
    registryModule.ToolRegistry.prototype.get = function patchedGet(name) {
      const definition = originalGet.call(this, name);
      if (name !== 'image_edit' || !definition) return definition;
      return {
        ...definition,
        async execute(args, ctx) {
          capturedArgs.push({
            attachmentId: args.attachmentId ?? null,
            referenceAttachmentIds: args.referenceAttachmentIds ?? null,
          });
          return definition.execute(args, ctx);
        },
      };
    };
    restoreRegistry = () => {
      registryModule.ToolRegistry.prototype.get = originalGet;
    };

    const userId = randomUUID();
    const conversationId = randomUUID();
    const overlayId = `att_${randomUUID().replaceAll('-', '')}`;
    const baseId = `att_${randomUUID().replaceAll('-', '')}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,email,password_hash,email_verified_at,created_at)
      VALUES (?,?,?,?,?)`).run(userId, `${userId}@example.invalid`, 'probe', now, now);
    db.prepare(`INSERT INTO conversations (id,user_id,title,created_at,updated_at)
      VALUES (?,?,?,?,?)`).run(conversationId, userId, 'multi-image probe', now, now);
    const insertAttachment = db.prepare(`INSERT INTO attachments
      (id,user_id,conversation_id,message_id,original_name,file_path,public_path,mime_type,size,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insertAttachment.run(overlayId, userId, conversationId, null, 'overlay.png', overlayPath, `/api/files/${overlayId}`, 'image/png', (await readFile(overlayPath)).byteLength, now);
    insertAttachment.run(baseId, userId, conversationId, null, 'base.png', basePath, `/api/files/${baseId}`, 'image/png', (await readFile(basePath)).byteLength, now);

    const { runAgentLoop } = await import('../src/server/modules/chat/engine/agent-loop.ts');
    const tools = [];
    let finalText = '';
    for await (const event of runAgentLoop({
      userId,
      conversationId,
      history: [],
      attachmentIds: [overlayId, baseId],
      userInput: '请实际生成图片：把第一张图片缩小后放在第二张图片右下角。第二张是主画布，除右下角新增内容外保持不变。',
      requestId: randomUUID(),
    })) {
      if (event.type === 'think') {
        const match = event.text.match(/正在调用工具：(.+)$/);
        if (match) tools.push(match[1]);
      } else if (event.type === 'delta') {
        finalText += event.text;
      }
    }

    console.info(`image_edit_args=${JSON.stringify(capturedArgs)}`);
    assert.ok(tools.includes('image_edit'), 'agent must call image_edit');
    assert.ok(capturedArgs.length >= 1, 'image_edit args must be captured');
    const selected = capturedArgs.at(-1);
    const primary = String(selected.attachmentId || '');
    const references = Array.isArray(selected.referenceAttachmentIds) ? selected.referenceAttachmentIds.map(String) : [];
    assert.ok(primary === baseId || /(?:第二|第2|图2|图片2|图像2)/.test(primary), 'agent must select the second uploaded image as primary');
    assert.ok(references.some(value => value === overlayId || /(?:第一|第1|图1|图片1|图像1)/.test(value)), 'agent must select the first uploaded image as a reference');
    const generation = db.prepare(`SELECT prompt, result_attachment_id, status
      FROM image_generations ORDER BY created_at DESC LIMIT 1`).get();
    assert.ok(generation, 'image generation row must exist');
    assert.equal(generation.status, 'completed');
    assert.match(generation.prompt, /Image 1 is the primary canvas/);
    assert.match(generation.prompt, /Image 2/i);
    assert.match(finalText, /!\[[^\]]*\]\(\/api\/files\/att_/);
    const result = db.prepare('SELECT file_path FROM attachments WHERE id=?').get(generation.result_attachment_id);
    assert.ok(result?.file_path, 'result attachment must exist');
    await copyFile(result.file_path, outputPath);
    console.info(`multi-image agent live probe passed: output=${outputPath}`);
  } finally {
    restoreRegistry?.();
    if (db?.open) db.close();
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
