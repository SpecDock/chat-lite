import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-search-'));
process.env.DATA_DIR = tempDir;
process.env.UPLOAD_DIR = join(tempDir, 'uploads');
process.env.DATABASE_PATH = join(tempDir, 'app.db');
process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
process.env.RAG_WRITE_ENABLED = 'false';
process.env.RAG_READ_ENABLED = 'false';
process.env.RAG_SHADOW_ENABLED = 'false';

const { db } = await import('../src/server/core/db.ts');
const { Router } = await import('../src/server/core/http.ts');
const { registerSearchRoutes } = await import('../src/server/modules/search/search.ts');
const {
  completeAssistantMessage,
  failAssistantMessage,
  insertAssistantStreamingMessage,
  insertUserMessage,
  interruptAssistantMessage,
  replaceLatestMessagePair
} = await import('../src/server/modules/chat/chat.repo.ts');
const { shutdownRag } = await import('../src/server/modules/rag/rag.ts');

const userId = 'search_user';
const otherUserId = 'search_other_user';
const token = 'search-session-token';
const otherToken = 'search-other-session-token';
const baseTime = Date.parse('2026-07-27T00:00:00.000Z');
const at = (seconds) => new Date(baseTime + seconds * 1000).toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');

const insertUser = db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)');
const insertConversation = db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)');
const insertMessage = db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)');

let server;
try {
  insertUser.run(userId, 'search@example.com', 'hash', at(0));
  insertUser.run(otherUserId, 'search-other@example.com', 'hash', at(0));
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run('search_session', userId, hash(token), '2099-01-01T00:00:00.000Z', at(0));
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run('search_other_session', otherUserId, hash(otherToken), '2099-01-01T00:00:00.000Z', at(0));

  insertConversation.run('conv_main', userId, 'titleonly secret conversation title', at(0), at(0));
  insertConversation.run('conv_other', otherUserId, 'Other conversation', at(0), at(0));

  insertMessage.run('visible_user', userId, 'conv_main', 'user', 'alpha visible user body', 'completed', at(1));
  insertMessage.run('visible_assistant', userId, 'conv_main', 'assistant', '<think>private reasoning</think>alpha visible assistant body', 'completed', at(2));
  insertMessage.run('hidden_error', userId, 'conv_main', 'assistant', 'hidden error needle', 'error', at(3));
  insertMessage.run('hidden_streaming', userId, 'conv_main', 'assistant', 'hidden streaming needle', 'streaming', at(4));
  insertMessage.run('hidden_think', userId, 'conv_main', 'assistant', '<think>think only needle</think>', 'completed', at(5));
  insertMessage.run('hidden_cancel', userId, 'conv_main', 'assistant', '已取消', 'interrupted', at(6));
  insertMessage.run('hidden_failure', userId, 'conv_main', 'assistant', '当前主模型调用失败，请稍后重试。', 'completed', at(7));
  insertMessage.run('one_char', userId, 'conv_main', 'user', '孤字符 fallback', 'completed', at(8));
  insertMessage.run('two_chars', userId, 'conv_main', 'assistant', 'xy fallback', 'completed', at(9));
  insertMessage.run('like_specials', userId, 'conv_main', 'user', 'literal % _ \\ fallback', 'completed', at(9));
  insertMessage.run('chinese_fts', userId, 'conv_main', 'assistant', '这里支持中文检索词命中', 'completed', at(10));
  insertMessage.run('special_fts', userId, 'conv_main', 'user', 'say "hi" + - * (x) special input', 'completed', at(11));
  insertMessage.run('markdown_image', userId, 'conv_main', 'assistant', '图片说明 ![可读替代文本](/api/files/private-url-noise)', 'completed', at(12));
  insertMessage.run('snippet_plain', userId, 'conv_main', 'assistant', 'snippetneedle **bold** <mark>unsafe</mark> [label](https://example.test)', 'completed', at(13));
  insertMessage.run('other_alpha', otherUserId, 'conv_other', 'user', 'alpha belongs to another user', 'completed', at(14));

  insertMessage.run('stale_invisible', userId, 'conv_main', 'assistant', 'stale invisible document', 'error', at(15));
  db.prepare(`INSERT INTO message_search_documents
    (message_id,user_id,conversation_id,role,search_text,created_at) VALUES (?,?,?,?,?,?)`
  ).run('stale_invisible', userId, 'conv_main', 'assistant', 'stale invisible document', at(15));
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO message_search_documents
    (message_id,user_id,conversation_id,role,search_text,created_at) VALUES (?,?,?,?,?,?)`
  ).run('missing_source', userId, 'conv_main', 'assistant', 'missing source document', at(16));
  db.pragma('foreign_keys = ON');

  insertConversation.run('conv_rank', userId, 'Rank title', at(20), at(20));
  insertMessage.run('rank_exact_old', userId, 'conv_rank', 'user', 'rankterm', 'completed', at(20));
  insertMessage.run('rank_prefix', userId, 'conv_rank', 'user', 'rankterm suffix', 'completed', at(23));
  insertMessage.run('rank_contains', userId, 'conv_rank', 'user', 'before rankterm after', 'completed', at(24));
  insertMessage.run('rank_exact_new', userId, 'conv_rank', 'assistant', 'rankterm', 'completed', at(22));

  insertConversation.run('conv_pages', userId, 'Pagination title', at(30), at(30));
  for (let index = 0; index < 35; index += 1) {
    insertMessage.run(`page_${index}`, userId, 'conv_pages', 'user', `paginationneedle result ${index}`, 'completed', at(30 + index));
  }

  const router = new Router();
  registerSearchRoutes(router);
  server = createServer((req, res) => { void router.handle(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (path, sessionToken = token) => {
    const headers = sessionToken ? { cookie: `chat_lite_session=${sessionToken}` } : {};
    const response = await fetch(`${origin}${path}`, { headers });
    const body = await response.json();
    return { response, body };
  };
  const search = (query, offset = 0, sessionToken = token) =>
    request(`/api/search/messages?q=${encodeURIComponent(query)}&offset=${offset}`, sessionToken);

  assert.equal((await search('alpha', 0, '')).response.status, 401, 'authentication is required');
  assert.deepEqual((await search('   ')).body, { items: [], hasMore: false, nextOffset: null }, 'blank query is empty');
  assert.deepEqual((await request('/api/search/messages')).body, { items: [], hasMore: false, nextOffset: null }, 'missing query is empty');
  assert.equal((await search('x'.repeat(201))).response.status, 400, 'query is capped at 200 Unicode characters');
  assert.equal((await request('/api/search/messages?q=alpha&offset=-1')).response.status, 400, 'negative offset is rejected');

  const alpha = (await search('alpha')).body.items;
  assert.deepEqual(new Set(alpha.map((item) => item.messageId)), new Set(['visible_user', 'visible_assistant']), 'visible user and assistant messages are returned');
  assert.deepEqual(new Set(alpha.map((item) => item.role)), new Set(['user', 'assistant']));
  assert.ok(alpha.every((item) => item.conversationId === 'conv_main' && item.conversationTitle.includes('titleonly')));
  assert.equal((await search('titleonly')).body.items.length, 0, 'conversation titles are not searched');
  assert.equal((await search('private reasoning')).body.items.length, 0, 'think blocks are not indexed');

  for (const query of ['hidden error', 'hidden streaming', 'think only', '已取消', '当前主模型调用失败']) {
    assert.equal((await search(query)).body.items.length, 0, `invisible message excluded: ${query}`);
  }
  assert.equal((await search('stale invisible')).body.items.length, 0, 'initialization deletes now-invisible documents');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message_search_documents WHERE message_id IN ('stale_invisible','missing_source')").get().count, 0, 'initialization removes stale documents');
  assert.equal((await search('alpha', 0, otherToken)).body.items[0].messageId, 'other_alpha', 'other user sees only their own hit');
  assert.equal((await search('孤')).body.items[0].messageId, 'one_char', 'one-character fallback works');
  assert.equal((await search('xy')).body.items[0].messageId, 'two_chars', 'two-character fallback works');
  for (const query of ['%', '_', '\\']) {
    assert.equal((await search(query)).body.items[0].messageId, 'like_specials', `LIKE metacharacter is escaped: ${query}`);
  }
  assert.equal((await search('中文检索')).body.items[0].messageId, 'chinese_fts', 'Chinese trigram FTS works');
  for (const query of ['say "hi" + - * (x)', '"""', '***', '(())']) {
    assert.equal((await search(query)).response.status, 200, `quoted special MATCH input is safe: ${query}`);
  }
  assert.equal((await search('可读替代文本')).body.items[0].messageId, 'markdown_image', 'image alt text remains searchable');
  assert.equal((await search('private-url-noise')).body.items.length, 0, 'Markdown image URL noise is removed');

  const ranked = (await search('rankterm')).body.items.map((item) => item.messageId);
  assert.deepEqual(ranked.slice(0, 4), ['rank_exact_new', 'rank_exact_old', 'rank_prefix', 'rank_contains'], 'exact and prefix priority precedes rank, with newest exact tie first');

  const firstPage = (await search('paginationneedle')).body;
  const secondPage = (await search('paginationneedle', firstPage.nextOffset)).body;
  assert.equal(firstPage.items.length, 30);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextOffset, 30);
  assert.equal(secondPage.items.length, 5);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextOffset, null);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.messageId)).size, 35, 'offset pages have no duplicate messages');

  insertConversation.run('conv_edit', userId, 'Edit title', at(100), at(100));
  insertUserMessage('edit_user', userId, 'conv_edit', 'oldeditneedle');
  insertAssistantStreamingMessage('edit_assistant', userId, 'conv_edit');
  completeAssistantMessage('edit_assistant', userId, 'oldassistantneedle');
  assert.equal((await search('oldassistantneedle')).body.items[0].messageId, 'edit_assistant', 'assistant completion is indexed');
  replaceLatestMessagePair({
    conversationId: 'conv_edit',
    userId,
    userMessageId: 'edit_user',
    userContent: 'neweditneedle',
    newAssistantId: 'unused_assistant',
    referencedAssistantAttachmentIds: []
  });
  assert.equal((await search('oldeditneedle')).body.items.length, 0, 'edited user content removes old index text');
  assert.equal((await search('neweditneedle')).body.items[0].messageId, 'edit_user', 'edited user content is searchable');
  assert.equal((await search('oldassistantneedle')).body.items.length, 0, 'assistant reset to streaming is removed from search');

  insertAssistantStreamingMessage('interrupt_assistant', userId, 'conv_edit');
  assert.equal((await search('interruptneedle')).body.items.length, 0, 'streaming assistant is not indexed');
  interruptAssistantMessage('interrupt_assistant', userId, 'interruptneedle partial answer');
  assert.equal((await search('interruptneedle')).body.items[0].messageId, 'interrupt_assistant', 'visible interrupted answer is indexed');
  failAssistantMessage('interrupt_assistant', userId, 'interruptneedle failed answer');
  assert.equal((await search('interruptneedle')).body.items.length, 0, 'failed assistant update removes its document');

  const snippet = (await search('snippetneedle')).body.items[0].snippet;
  assert.equal(snippet.includes('snippetneedle'), true);
  assert.doesNotMatch(snippet, /<[^>]+>|\*\*|<mark>/i, 'snippet contains no HTML or highlight markers');

  insertConversation.run('conv_delete_message', userId, 'Delete message title', at(110), at(110));
  insertUserMessage('delete_message', userId, 'conv_delete_message', 'deletemessageneedle');
  db.prepare('DELETE FROM messages WHERE id=?').run('delete_message');
  assert.equal((await search('deletemessageneedle')).body.items.length, 0, 'message deletion cascades to search index');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message_search_documents WHERE message_id='delete_message'").get().count, 0);

  insertConversation.run('conv_delete_all', userId, 'Delete conversation title', at(120), at(120));
  insertUserMessage('delete_conversation_message', userId, 'conv_delete_all', 'deleteconversationneedle');
  db.prepare('DELETE FROM conversations WHERE id=?').run('conv_delete_all');
  assert.equal((await search('deleteconversationneedle')).body.items.length, 0, 'conversation deletion cascades to search index');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message_search_documents WHERE conversation_id='conv_delete_all'").get().count, 0);

  console.info('search backend sanity passed');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  shutdownRag();
  db.close();
  await rm(tempDir, { recursive: true, force: true });
}
