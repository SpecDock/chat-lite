import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'chat-lite-message-pair-'));
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = join(dataDir, 'uploads');
process.env.DATABASE_PATH = join(dataDir, 'app.db');
process.env.RAG_DATABASE_PATH = join(dataDir, 'rag.db');
process.env.RAG_WRITE_ENABLED = 'false';
process.env.RAG_READ_ENABLED = 'false';
process.env.RAG_SHADOW_ENABLED = 'false';
process.env.EMBEDDING_DIMENSIONS = '4';

const { db } = await import('../src/server/infrastructure/db/db.ts');
const {
  appendEditedMessagePair,
  conversationExists,
  deleteMessagePairData,
  getMessagePair,
  listMessageAttachments,
  listMessages,
  replaceLatestMessagePair
} = await import('../src/server/infrastructure/chat/chat.repo.ts');
const {
  attachmentIdsFromContent,
  cloneUserAttachments,
  discardClonedAttachments,
  removeAttachmentFiles,
  stripUserImageContent,
  userMessageContent
} = await import('../src/server/application/chat/chat.service.ts');
const { insertChunk, listAllItemsByMessage } = await import('../src/server/infrastructure/rag/rag.repo.ts');
const { purgeOrphanedRagChunks } = await import('../src/server/application/rag/rag.service.ts');
const { ragDb } = await import('../src/server/infrastructure/rag/rag-db.ts');
const { shutdownRag } = await import('../src/server/application/rag/rag.ts');

const userId = 'user_pair_test';
const conversationId = 'conv_pair_test';
const createdAt = '2026-07-20T00:00:00.000Z';
const uploadDir = join(dataDir, 'uploads', userId);
const userFile = join(uploadDir, 'att_user.png');
const generatedFile = join(uploadDir, 'att_generated.png');

try {
  await mkdir(uploadDir, { recursive: true });
  await writeFile(userFile, Buffer.from('user-image'));
  await writeFile(generatedFile, Buffer.from('generated-image'));

  db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)')
    .run(userId, 'pair-test@example.com', 'hash', createdAt);
  db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(conversationId, userId, '第一问', createdAt, createdAt);
  const insertMessage = db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)');
  insertMessage.run('msg_user_1', userId, conversationId, 'user', '第一问\n\n![image](/api/files/att_user)', 'completed', createdAt);
  insertMessage.run('msg_system_between', userId, conversationId, 'system', '中间系统消息', 'completed', createdAt);
  insertMessage.run('msg_tool_between', userId, conversationId, 'tool', '中间工具消息', 'completed', createdAt);
  insertMessage.run('msg_assistant_1', userId, conversationId, 'assistant', '失败前的部分回答\n\n![生成图片](/api/files/att_generated)', 'error', createdAt);
  insertMessage.run('msg_user_2', userId, conversationId, 'user', '第二问', 'completed', createdAt);
  insertMessage.run('msg_assistant_2', userId, conversationId, 'assistant', '第二答', 'interrupted', createdAt);

  const insertAttachment = db.prepare(`INSERT INTO attachments
    (id,user_id,conversation_id,message_id,original_name,file_path,public_path,mime_type,size,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insertAttachment.run('att_user', userId, conversationId, 'msg_user_1', 'user.png', userFile, '/api/files/att_user', 'image/png', 10, createdAt);
  insertAttachment.run('att_generated', userId, conversationId, null, 'generated.png', generatedFile, '/api/files/att_generated', 'image/png', 15, createdAt);
  db.prepare('UPDATE users SET avatar_attachment_id=? WHERE id=?').run('att_generated', userId);
  db.prepare('INSERT INTO image_generations (id,user_id,prompt,model,status,result_attachment_id,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('img_pair', userId, '生成图片', 'image-model', 'completed', 'att_generated', createdAt);
  db.prepare('INSERT INTO token_usage (user_id,conversation_id,message_id,model,total_tokens,created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, conversationId, 'msg_assistant_1', 'chat-model', 12, createdAt);
  db.prepare('INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at) VALUES (?,?,?,?,?)')
    .run(userId, 'img_pair', 'image-model', 1, createdAt);

  insertChunk({ id: 'rag_user_1', userId, conversationId, messageId: 'msg_user_1', role: 'user', chunkIndex: 0, chunkText: '第一问 RAG', createdAt });
  insertChunk({ id: 'rag_assistant_1', userId, conversationId, messageId: 'msg_assistant_1', role: 'assistant', chunkIndex: 0, chunkText: '第一答 RAG', createdAt });
  insertChunk({ id: 'rag_user_2', userId, conversationId, messageId: 'msg_user_2', role: 'user', chunkIndex: 0, chunkText: '第二问 RAG', createdAt });

  const firstPair = getMessagePair(conversationId, userId, 'msg_user_1');
  assert.equal(firstPair?.assistant?.id, 'msg_assistant_1', 'pair resolution skips system/tool rows before the next user');
  assert.equal(firstPair?.isFirst, true);
  assert.equal(firstPair?.isLatest, false);
  assert.equal(getMessagePair(conversationId, userId, 'msg_assistant_1'), undefined, 'assistant IDs cannot address a pair');

  const firstDeletion = deleteMessagePairData({
    conversationId,
    userId,
    userMessageId: 'msg_user_1',
    referencedAttachmentIds: ['att_user', 'att_generated']
  });
  await removeAttachmentFiles(firstDeletion.attachments);

  assert.equal(firstDeletion.conversationDeleted, false);
  assert.deepEqual(listMessages(conversationId, userId).map(message => message.id), ['msg_system_between', 'msg_tool_between', 'msg_user_2', 'msg_assistant_2'], 'non-pair and later messages are retained');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id IN ('att_user','att_generated')").get().count, 0);
  assert.equal(existsSync(userFile), false, 'uploaded file is deleted');
  assert.equal(existsSync(generatedFile), false, 'generated file is deleted');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE id='img_pair'").get().count, 0);
  assert.equal(db.prepare('SELECT avatar_attachment_id FROM users WHERE id=?').get(userId).avatar_attachment_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 1, 'token usage remains append-only');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_usage').get().count, 1, 'image usage remains append-only');
  assert.equal(listAllItemsByMessage(userId, 'msg_user_1').length, 0, 'user RAG chunks are deleted');
  assert.equal(listAllItemsByMessage(userId, 'msg_assistant_1').length, 0, 'assistant RAG chunks are deleted');
  assert.equal(listAllItemsByMessage(userId, 'msg_user_2').length, 1, 'later RAG chunks are retained');

  insertChunk({
    id: 'rag_orphan',
    userId,
    conversationId,
    messageId: 'msg_missing',
    role: 'user',
    chunkIndex: 0,
    chunkText: '孤儿 RAG 块',
    createdAt,
    embedding: new Float32Array([1, 0, 0, 0]),
    dimensions: 4
  });
  const ragDatabase = ragDb();
  const orphanRowid = listAllItemsByMessage(userId, 'msg_missing')[0].rowid;
  assert.ok(ragDatabase.raw.prepare('SELECT 1 FROM fts_rag_items WHERE rowid=?').get(orphanRowid), 'orphan has an FTS row before cleanup');
  if (ragDatabase.vectorAvailable) assert.ok(ragDatabase.raw.prepare('SELECT 1 FROM vec_rag_items WHERE rowid=?').get(BigInt(orphanRowid)), 'orphan has a vector row before cleanup');
  assert.equal(await purgeOrphanedRagChunks(), 1, 'callable orphan cleanup removes the metadata row');
  assert.equal(listAllItemsByMessage(userId, 'msg_missing').length, 0);
  assert.equal(ragDatabase.raw.prepare('SELECT 1 FROM fts_rag_items WHERE rowid=?').get(orphanRowid), undefined, 'orphan FTS row is deleted');
  if (ragDatabase.vectorAvailable) assert.equal(ragDatabase.raw.prepare('SELECT 1 FROM vec_rag_items WHERE rowid=?').get(BigInt(orphanRowid)), undefined, 'orphan vector row is deleted');
  assert.equal(listAllItemsByMessage(userId, 'msg_user_2').length, 1, 'orphan cleanup retains existing messages');

  const residualFile = join(uploadDir, 'att_residual.png');
  await writeFile(residualFile, Buffer.from('unbound-residual'));
  insertAttachment.run('att_residual', userId, conversationId, null, 'residual.png', residualFile, '/api/files/att_residual', 'image/png', 16, createdAt);
  db.prepare('INSERT INTO image_generations (id,user_id,prompt,model,status,result_attachment_id,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('img_residual', userId, '未绑定残留', 'image-model', 'completed', 'att_residual', createdAt);
  db.prepare('INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at) VALUES (?,?,?,?,?)')
    .run(userId, 'img_residual', 'image-model', 1, createdAt);

  const secondDeletion = deleteMessagePairData({
    conversationId,
    userId,
    userMessageId: 'msg_user_2',
    referencedAttachmentIds: []
  });
  await removeAttachmentFiles(secondDeletion.attachments);
  assert.equal(secondDeletion.conversationDeleted, true);
  assert.equal(conversationExists(conversationId, userId), false, 'empty conversation is deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?').get(conversationId).count, 0, 'all residual conversation attachments are deleted');
  assert.equal(existsSync(residualFile), false, 'unbound residual file is deleted');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE id='img_residual'").get().count, 0, 'residual image generation is deleted');
  assert.equal(listAllItemsByMessage(userId, 'msg_user_2').length, 0, 'conversation RAG is deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_usage').get().count, 2, 'residual image usage remains append-only');

  assert.equal(stripUserImageContent('可编辑文字\n\n![image](/api/files/att_old)'), '可编辑文字');
  assert.deepEqual(attachmentIdsFromContent('![一](/api/files/att_a)\n![二](/api/files/att_b)'), ['att_a', 'att_b']);
  assert.equal(userMessageContent('', ['att_a']), '![image](/api/files/att_a)');

  const editConversationId = 'conv_edit_test';
  const editUserFile = join(uploadDir, 'att_edit_user.png');
  const editAssistantFile = join(uploadDir, 'att_edit_assistant.png');
  await writeFile(editUserFile, Buffer.from('edit-user-image'));
  await writeFile(editAssistantFile, Buffer.from('edit-assistant-image'));
  db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(editConversationId, userId, '编辑前', createdAt, createdAt);
  insertMessage.run('msg_edit_user', userId, editConversationId, 'user', '编辑前\n\n![image](/api/files/att_edit_user)', 'completed', createdAt);
  insertMessage.run('msg_edit_assistant', userId, editConversationId, 'assistant', '旧回答\n\n![生成图片](/api/files/att_edit_assistant)', 'completed', createdAt);
  insertAttachment.run('att_edit_user', userId, editConversationId, 'msg_edit_user', 'edit-user.png', editUserFile, '/api/files/att_edit_user', 'image/png', 15, createdAt);
  insertAttachment.run('att_edit_assistant', userId, editConversationId, null, 'edit-assistant.png', editAssistantFile, '/api/files/att_edit_assistant', 'image/png', 20, createdAt);
  db.prepare('INSERT INTO image_generations (id,user_id,prompt,model,status,result_attachment_id,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('img_edit', userId, '旧生成', 'image-model', 'completed', 'att_edit_assistant', createdAt);
  db.prepare('INSERT INTO image_usage (user_id,image_generation_id,model,cost_units,created_at) VALUES (?,?,?,?,?)')
    .run(userId, 'img_edit', 'image-model', 1, createdAt);
  insertChunk({ id: 'rag_edit_user', userId, conversationId: editConversationId, messageId: 'msg_edit_user', role: 'user', chunkIndex: 0, chunkText: '编辑前 RAG', createdAt });
  insertChunk({ id: 'rag_edit_assistant', userId, conversationId: editConversationId, messageId: 'msg_edit_assistant', role: 'assistant', chunkIndex: 0, chunkText: '旧回答 RAG', createdAt });

  const replacement = replaceLatestMessagePair({
    conversationId: editConversationId,
    userId,
    userMessageId: 'msg_edit_user',
    userContent: userMessageContent('编辑后', ['att_edit_user']),
    newAssistantId: 'msg_unused',
    referencedAssistantAttachmentIds: ['att_edit_assistant']
  });
  await removeAttachmentFiles(replacement.attachments);
  assert.equal(replacement.assistantId, 'msg_edit_assistant', 'latest edit reuses the assistant ID');
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='msg_edit_user'").get().content, '编辑后\n\n![image](/api/files/att_edit_user)');
  assert.equal(db.prepare("SELECT status FROM messages WHERE id='msg_edit_assistant'").get().status, 'streaming');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id='att_edit_user'").get().count, 1, 'latest edit retains user attachments');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id='att_edit_assistant'").get().count, 0, 'latest edit removes old assistant artifacts');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_generations WHERE id='img_edit'").get().count, 0, 'latest edit removes the linked generation');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM image_usage WHERE image_generation_id='img_edit'").get().count, 1, 'latest edit retains image usage');
  assert.equal(existsSync(editAssistantFile), false);
  assert.equal(listAllItemsByMessage(userId, 'msg_edit_user').length, 0);
  assert.equal(listAllItemsByMessage(userId, 'msg_edit_assistant').length, 0);

  db.prepare("UPDATE messages SET content='新回答',status='completed' WHERE id='msg_edit_assistant'").run();
  insertMessage.run('msg_edit_user_2', userId, editConversationId, 'user', '后续问题', 'completed', createdAt);
  insertMessage.run('msg_edit_assistant_2', userId, editConversationId, 'assistant', '后续回答', 'completed', createdAt);
  const sourceAttachments = listMessageAttachments('msg_edit_user', editConversationId, userId);
  const clones = await cloneUserAttachments(sourceAttachments, userId, editConversationId);
  assert.equal(clones.length, 1);
  assert.notEqual(clones[0].id, 'att_edit_user');
  assert.equal(existsSync(clones[0].file_path), true, 'historical edit physically clones user attachments');
  appendEditedMessagePair({
    conversationId: editConversationId,
    userId,
    originalUserMessageId: 'msg_edit_user',
    userMessageId: 'msg_edit_append_user',
    assistantId: 'msg_edit_append_assistant',
    userContent: userMessageContent('历史编辑', [clones[0].id]),
    attachmentIds: [clones[0].id]
  });
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='msg_edit_user'").get().content, '编辑后\n\n![image](/api/files/att_edit_user)', 'historical edit retains the original pair');
  assert.equal(db.prepare("SELECT message_id FROM attachments WHERE id=?").get(clones[0].id).message_id, 'msg_edit_append_user');
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='msg_edit_append_user'").get().content, `历史编辑\n\n![image](/api/files/${clones[0].id})`);
  assert.throws(
    () => deleteMessagePairData({ conversationId: editConversationId, userId, userMessageId: 'msg_edit_user', referencedAttachmentIds: [] }),
    error => error?.status === 409,
    'streaming assistants block pair mutations'
  );

  const messagesBeforeConflict = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(editConversationId).count;
  const attachmentsBeforeConflict = db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?').get(editConversationId).count;
  const competingClones = await cloneUserAttachments(sourceAttachments, userId, editConversationId);
  assert.throws(
    () => appendEditedMessagePair({
      conversationId: editConversationId,
      userId,
      originalUserMessageId: 'msg_edit_user',
      userMessageId: 'msg_conflict_user',
      assistantId: 'msg_conflict_assistant',
      userContent: userMessageContent('并发历史编辑', [competingClones[0].id]),
      attachmentIds: [competingClones[0].id]
    }),
    error => error?.status === 409,
    'second append is rejected by the transaction-level streaming check'
  );
  await discardClonedAttachments(competingClones, userId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(editConversationId).count, messagesBeforeConflict, 'conflicting append creates no messages');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?').get(editConversationId).count, attachmentsBeforeConflict, 'conflicting append clones are rolled back');
  assert.throws(
    () => replaceLatestMessagePair({
      conversationId: editConversationId,
      userId,
      userMessageId: 'msg_edit_append_user',
      userContent: '并发最新编辑',
      newAssistantId: 'msg_conflict_replace_assistant',
      referencedAssistantAttachmentIds: []
    }),
    error => error?.status === 409,
    'second replace is rejected by the transaction-level streaming check'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(editConversationId).count, messagesBeforeConflict);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE conversation_id=?').get(editConversationId).count, attachmentsBeforeConflict);

  const prepareConversationId = 'conv_prepare_failure';
  const sessionToken = 'message-pair-session-token';
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run('session_pair_test', userId, createHash('sha256').update(sessionToken).digest('hex'), '2099-01-01T00:00:00.000Z', createdAt);
  db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(prepareConversationId, userId, '准备失败前', createdAt, createdAt);
  insertMessage.run('msg_prepare_user', userId, prepareConversationId, 'user', '准备失败前', 'completed', createdAt);
  insertMessage.run('msg_prepare_assistant', userId, prepareConversationId, 'assistant', '旧回答', 'completed', createdAt);
  db.exec(`CREATE TRIGGER force_prepare_title_failure
    BEFORE UPDATE OF title ON conversations
    WHEN NEW.id='${prepareConversationId}'
    BEGIN SELECT RAISE(ABORT, 'forced title failure'); END`);
  const { Router } = await import('../src/server/interfaces/http/http.ts');
  const { registerChatRoutes } = await import('../src/server/interfaces/http/chat.ts');
  const router = new Router();
  registerChatRoutes(router);
  const server = createServer((req, res) => { void router.handle(req, res); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `chat_lite_session=${sessionToken}` },
      body: JSON.stringify({ conversationId: prepareConversationId, editUserMessageId: 'msg_prepare_user', content: '准备失败后' })
    });
    assert.equal(response.status, 500, 'pre-SSE preparation errors retain Router status JSON');
    assert.match((await response.json()).error, /forced title failure/);
    const compensated = db.prepare("SELECT content,status FROM messages WHERE id='msg_prepare_assistant'").get();
    assert.equal(compensated.status, 'error', 'persisted streaming assistant is compensated to error');
    assert.match(compensated.content, /forced title failure/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.exec('DROP TRIGGER IF EXISTS force_prepare_title_failure');
  }

  console.info('message pair sanity passed');
} finally {
  shutdownRag();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
}
