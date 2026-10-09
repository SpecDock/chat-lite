import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';

const tempDir = await mkdtemp(join(tmpdir(), 'chat-lite-context-snapshot-'));
process.env.DATA_DIR = tempDir;
process.env.UPLOAD_DIR = join(tempDir, 'uploads');
process.env.DATABASE_PATH = join(tempDir, 'app.db');
process.env.RAG_DATABASE_PATH = join(tempDir, 'rag.db');
process.env.RAG_WRITE_ENABLED = 'false';
process.env.RAG_READ_ENABLED = 'false';
process.env.RAG_SHADOW_ENABLED = 'false';
process.env.CONVERSATION_CACHE_IDLE_MINUTES = '15';
process.env.ANSWER_HISTORY_LIMIT = '2';

// Server sources import siblings as .js. Plain Node cannot resolve those to .ts;
// tsx is the same TypeScript runner as `npm run dev:server`.
register();

const { db } = await import('../src/server/infrastructure/db/db.ts');
const {
  commitContextSnapshot,
  createPendingContextSnapshot,
  failContextSnapshot,
  getContextSnapshot,
  getCurrentContextSnapshot,
  invalidateAllContextSnapshots,
  invalidateContextSnapshotsAfterCursor,
  invalidateContextSnapshotsFromCursor,
  parseModelContext,
  serializeModelContext,
} = await import('../src/server/application/chat/conversation-context-snapshot.service.ts');
const { prepareConversationContext } = await import('../src/server/application/chat/conversation-context.service.ts');
const {
  snapshotMatchesSystemPrompt,
  serializeAgentTranscript,
  supplementalModelMessages,
} = await import('../src/server/application/chat/conversation-context-snapshot.transcript.ts');
const { assistantReasoningReplayKey } = await import('../src/server/infrastructure/llm/prompt-cache.ts');
const { restoreSnapshotMessages, systemPromptForRun } = await import('../src/server/application/chat/engine/agent-loop.ts');
const { convertMessagesToCompletionsMessageParams } = await import('@langchain/openai');
const {
  appendEditedMessagePair,
  deleteMessagePairData,
  replaceLatestMessagePair,
} = await import('../src/server/infrastructure/chat/chat.repo.ts');
const { closeRagDb } = await import('../src/server/infrastructure/rag/rag-db.ts');

const baseTime = Date.parse('2026-09-26T00:00:00.000Z');
const at = (seconds) => new Date(baseTime + seconds * 1000).toISOString();
const insertUser = db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)');
const insertConversation = db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?)');

function snapshotCount(conversationId) {
  return db.prepare('SELECT COUNT(*) AS count FROM conversation_context_snapshots WHERE conversation_id=?').get(conversationId).count;
}

function currentCount(conversationId, userId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM conversation_context_snapshots
    WHERE conversation_id=? AND user_id=? AND status='current'`).get(conversationId, userId).count;
}

function createSnapshot(conversationId, userId, messageId, createdAt, messages) {
  const created = createPendingContextSnapshot({
    conversationId,
    userId,
    coveredMessageId: messageId,
    coveredMessageCreatedAt: createdAt,
    messages,
  });
  assert.ok(created, `pending snapshot for ${conversationId} was not created`);
  return created;
}

const transcript = [
  { role: 'system', content: '系统约束' },
  { role: 'human', content: '你好' },
  {
    role: 'ai',
    content: '',
    reasoning_content: '先查再答',
    tool_calls: [{ id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' }],
  },
  { role: 'tool', content: '检索结果', tool_call_id: 'call_1' },
  { role: 'ai', content: '最终回答', reasoning_content: '' },
];

try {
  const serialized = serializeModelContext(transcript);
  assert.deepEqual(parseModelContext(serialized), transcript, 'model context round-trips');
  assert.equal(serializeModelContext(parseModelContext(serialized)), serialized, 'canonical JSON is stable');
  assert.equal(serialized.includes('"reasoning_content"'), true);
  assert.equal(serialized.includes('"tool_calls"'), true);
  assert.equal(serialized.includes('"tool_call_id"'), true);
  assert.throws(() => serializeModelContext([{ role: 'assistant', content: 'no' }]), /invalid role/);
  assert.throws(() => serializeModelContext([{ role: 'tool', content: 'x' }]), /tool_call_id/);
  const imageUrl = 'data:image/png;base64,abcdSNAPSHOT';
  const blocks = [{
    role: 'human',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  }];
  const blockJson = serializeModelContext(blocks);
  assert.deepEqual(parseModelContext(blockJson), blocks, 'content blocks round-trip');
  assert.equal(serializeModelContext(parseModelContext(blockJson)), blockJson, 'content block JSON is stable');
  assert.throws(() => serializeModelContext([{
    role: 'human',
    content: [{ type: 'image', image_url: { url: imageUrl } }],
  }]), /invalid type/);
  assert.throws(() => serializeModelContext([{ role: 'ai', content: [{ type: 'text', text: 'no' }] }]), /must be a string/);

  insertUser.run('user_a', 'a@example.com', 'hash', at(0));
  insertUser.run('user_b', 'b@example.com', 'hash', at(0));
  insertConversation.run('conv_switch', 'user_a', 'switch', at(0), at(0));
  insertConversation.run('conv_fail', 'user_a', 'fail', at(0), at(0));
  insertConversation.run('conv_rollback', 'user_a', 'rollback', at(0), at(0));
  insertConversation.run('conv_cursor', 'user_a', 'cursor', at(0), at(0));
  insertConversation.run('conv_tie', 'user_a', 'tie', at(0), at(0));
  insertConversation.run('conv_a', 'user_a', 'owned by a', at(0), at(0));
  insertConversation.run('conv_b', 'user_b', 'owned by b', at(0), at(0));
  insertConversation.run('conv_cascade', 'user_a', 'cascade', at(0), at(0));

  const firstMessages = [{ role: 'human', content: 'version one' }];
  const first = createSnapshot('conv_switch', 'user_a', 'm1', at(1), firstMessages);
  assert.equal(first.status, 'pending');
  assert.equal(first.version, 1);
  const publishedFirst = commitContextSnapshot({ snapshotId: first.id, conversationId: 'conv_switch', userId: 'user_a' });
  assert.equal(publishedFirst.id, first.id, 'snapshot id is immutable');
  assert.equal(publishedFirst.version, first.version, 'snapshot version is immutable');
  assert.equal(publishedFirst.createdAt, first.createdAt, 'snapshot created_at is immutable');
  assert.equal(publishedFirst.status, 'current');
  assert.deepEqual(publishedFirst.messages, firstMessages);

  const second = createSnapshot('conv_switch', 'user_a', 'm2', at(2), transcript);
  assert.equal(getCurrentContextSnapshot('conv_switch', 'user_a')?.id, first.id, 'pending version does not replace current');
  const publishedSecond = commitContextSnapshot({ snapshotId: second.id, conversationId: 'conv_switch', userId: 'user_a' });
  assert.equal(publishedSecond.version, 2);
  assert.deepEqual(publishedSecond.messages, transcript);
  assert.equal(getCurrentContextSnapshot('conv_switch', 'user_a')?.id, second.id);
  assert.equal(currentCount('conv_switch', 'user_a'), 1, 'only one current snapshot');
  const superseded = getContextSnapshot(first.id, 'conv_switch', 'user_a');
  assert.equal(superseded?.status, 'superseded');
  assert.equal(superseded?.version, 1);
  assert.deepEqual(superseded?.messages, firstMessages, 'old snapshot payload stays immutable');
  const stored = db.prepare('SELECT context_json FROM conversation_context_snapshots WHERE id=?').get(second.id);
  assert.equal(stored.context_json, serialized, 'snapshot stores canonical model context JSON');
  assert.throws(() => {
    db.prepare(`UPDATE conversation_context_snapshots SET status='current' WHERE id=?`).run(first.id);
  }, /UNIQUE/, 'a conversation cannot have two current snapshots');

  const kept = createSnapshot('conv_fail', 'user_a', 'm1', at(1), [{ role: 'human', content: 'keep me' }]);
  const current = commitContextSnapshot({ snapshotId: kept.id, conversationId: 'conv_fail', userId: 'user_a' });
  const failedAttempt = createSnapshot('conv_fail', 'user_a', 'm2', at(2), [{ role: 'human', content: 'do not publish' }]);
  assert.deepEqual(getCurrentContextSnapshot('conv_fail', 'user_a'), current);
  const failed = failContextSnapshot({ snapshotId: failedAttempt.id, conversationId: 'conv_fail', userId: 'user_a' });
  assert.equal(failed.status, 'invalid');
  assert.equal(failed.version, 2);
  assert.deepEqual(failed.messages, [{ role: 'human', content: 'do not publish' }]);
  assert.deepEqual(getCurrentContextSnapshot('conv_fail', 'user_a'), current, 'failed snapshot does not replace current');
  assert.throws(() => commitContextSnapshot({ snapshotId: failed.id, conversationId: 'conv_fail', userId: 'user_a' }));
  assert.throws(() => commitContextSnapshot({ snapshotId: 'missing', conversationId: 'conv_fail', userId: 'user_a' }));
  assert.throws(() => failContextSnapshot({ snapshotId: current.id, conversationId: 'conv_fail', userId: 'user_a' }));
  assert.deepEqual(getCurrentContextSnapshot('conv_fail', 'user_a'), current, 'rejected commit keeps the old current snapshot');

  const stableMessages = [{ role: 'human', content: 'stable current' }];
  const stable = createSnapshot('conv_rollback', 'user_a', 'm1', at(1), stableMessages);
  const stableCurrent = commitContextSnapshot({ snapshotId: stable.id, conversationId: 'conv_rollback', userId: 'user_a' });
  const doomedMessages = [{ role: 'ai', content: 'should stay pending' }];
  const doomed = createSnapshot('conv_rollback', 'user_a', 'm2', at(2), doomedMessages);
  assert.match(doomed.id, /^snapshot_[A-Za-z0-9_-]+$/);
  db.exec(`CREATE TEMP TRIGGER conversation_context_snapshot_commit_fail
    BEFORE UPDATE OF status ON conversation_context_snapshots
    WHEN NEW.status = 'current' AND OLD.id = '${doomed.id}'
    BEGIN
      SELECT RAISE(ABORT, 'forced snapshot commit failure');
    END;`);
  try {
    assert.throws(
      () => commitContextSnapshot({ snapshotId: doomed.id, conversationId: 'conv_rollback', userId: 'user_a' }),
      /forced snapshot commit failure/
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS conversation_context_snapshot_commit_fail');
  }
  assert.deepEqual(getCurrentContextSnapshot('conv_rollback', 'user_a'), stableCurrent, 'rolled back commit keeps the old current snapshot');
  assert.equal(getContextSnapshot(stable.id, 'conv_rollback', 'user_a')?.status, 'current');
  assert.deepEqual(getContextSnapshot(stable.id, 'conv_rollback', 'user_a')?.messages, stableMessages);
  assert.equal(getContextSnapshot(doomed.id, 'conv_rollback', 'user_a')?.status, 'pending', 'failed commit does not publish the pending snapshot');
  assert.deepEqual(getContextSnapshot(doomed.id, 'conv_rollback', 'user_a')?.messages, doomedMessages);

  const cursorFirst = createSnapshot('conv_cursor', 'user_a', 'm1', at(1), [{ role: 'system', content: 'covered by m1' }]);
  commitContextSnapshot({ snapshotId: cursorFirst.id, conversationId: 'conv_cursor', userId: 'user_a' });
  const cursorCurrent = createSnapshot('conv_cursor', 'user_a', 'm2', at(2), [{ role: 'human', content: 'covered by m2' }]);
  commitContextSnapshot({ snapshotId: cursorCurrent.id, conversationId: 'conv_cursor', userId: 'user_a' });
  const cursorPending = createSnapshot('conv_cursor', 'user_a', 'm3', at(3), [{ role: 'ai', content: 'covered by m3' }]);
  const invalidated = invalidateContextSnapshotsAfterCursor({
    conversationId: 'conv_cursor',
    userId: 'user_a',
    cursorTime: at(2),
    cursorId: 'm2',
  });
  assert.equal(invalidated, 1, 'only snapshots strictly after the cursor are invalidated');
  assert.equal(getContextSnapshot(cursorFirst.id, 'conv_cursor', 'user_a')?.status, 'superseded');
  assert.deepEqual(getContextSnapshot(cursorFirst.id, 'conv_cursor', 'user_a')?.messages, [{ role: 'system', content: 'covered by m1' }], 'snapshot before the cursor stays unchanged');
  assert.equal(getCurrentContextSnapshot('conv_cursor', 'user_a')?.id, cursorCurrent.id, 'snapshot at the cursor stays current');
  assert.deepEqual(getCurrentContextSnapshot('conv_cursor', 'user_a')?.messages, [{ role: 'human', content: 'covered by m2' }]);
  assert.equal(getContextSnapshot(cursorPending.id, 'conv_cursor', 'user_a')?.status, 'invalid');
  assert.deepEqual(getContextSnapshot(cursorPending.id, 'conv_cursor', 'user_a')?.messages, [{ role: 'ai', content: 'covered by m3' }], 'invalidated snapshot payload stays immutable');
  assert.equal(invalidateContextSnapshotsAfterCursor({
    conversationId: 'conv_cursor',
    userId: 'user_a',
    cursorTime: at(2),
    cursorId: 'm2',
  }), 0, 'invalidation is idempotent');

  const tieFirst = createSnapshot('conv_tie', 'user_a', 'm1', at(5), [{ role: 'human', content: 'same time m1' }]);
  commitContextSnapshot({ snapshotId: tieFirst.id, conversationId: 'conv_tie', userId: 'user_a' });
  const tieSecond = createSnapshot('conv_tie', 'user_a', 'm2', at(5), [{ role: 'human', content: 'same time m2' }]);
  commitContextSnapshot({ snapshotId: tieSecond.id, conversationId: 'conv_tie', userId: 'user_a' });
  assert.equal(invalidateContextSnapshotsAfterCursor({
    conversationId: 'conv_tie',
    userId: 'user_a',
    cursorTime: at(5),
    cursorId: 'm1',
  }), 1);
  assert.equal(getContextSnapshot(tieFirst.id, 'conv_tie', 'user_a')?.status, 'superseded', 'equal cursor is not invalidated');
  assert.equal(getContextSnapshot(tieSecond.id, 'conv_tie', 'user_a')?.status, 'invalid', 'same timestamp uses message id ordering');
  assert.equal(getCurrentContextSnapshot('conv_tie', 'user_a'), undefined, 'invalidation does not resurrect an older snapshot');

  const ownedByA = createSnapshot('conv_a', 'user_a', 'm1', at(1), [{ role: 'human', content: 'alpha' }]);
  commitContextSnapshot({ snapshotId: ownedByA.id, conversationId: 'conv_a', userId: 'user_a' });
  const ownedByB = createSnapshot('conv_b', 'user_b', 'm1', at(1), [{ role: 'human', content: 'beta' }]);
  commitContextSnapshot({ snapshotId: ownedByB.id, conversationId: 'conv_b', userId: 'user_b' });
  assert.equal(getCurrentContextSnapshot('conv_a', 'user_b'), undefined);
  assert.equal(getCurrentContextSnapshot('conv_b', 'user_a'), undefined);
  assert.equal(getContextSnapshot(ownedByA.id, 'conv_a', 'user_b'), undefined);
  assert.equal(createPendingContextSnapshot({
    conversationId: 'conv_a',
    userId: 'user_b',
    coveredMessageId: 'm9',
    coveredMessageCreatedAt: at(9),
    messages: [{ role: 'human', content: 'cross user' }],
  }), undefined, 'a user cannot snapshot another user conversation');
  assert.equal(snapshotCount('conv_a'), 1);
  assert.throws(() => commitContextSnapshot({ snapshotId: ownedByA.id, conversationId: 'conv_a', userId: 'user_b' }));
  assert.throws(() => failContextSnapshot({ snapshotId: ownedByA.id, conversationId: 'conv_a', userId: 'user_b' }));
  assert.equal(invalidateContextSnapshotsAfterCursor({
    conversationId: 'conv_b',
    userId: 'user_b',
    cursorTime: at(0),
    cursorId: 'm0',
  }), 1);
  assert.equal(getCurrentContextSnapshot('conv_a', 'user_a')?.messages[0].content, 'alpha', 'another user invalidation stays isolated');
  assert.equal(getCurrentContextSnapshot('conv_b', 'user_b'), undefined);

  const cascade = createSnapshot('conv_cascade', 'user_a', 'm1', at(1), [{ role: 'human', content: 'gone with conversation' }]);
  commitContextSnapshot({ snapshotId: cascade.id, conversationId: 'conv_cascade', userId: 'user_a' });
  const cascadeForeignKey = db.prepare('PRAGMA foreign_key_list(conversation_context_snapshots)').all()
    .find((foreignKey) => foreignKey.table === 'conversations');
  assert.equal(cascadeForeignKey?.on_delete, 'CASCADE');
  db.prepare('DELETE FROM conversations WHERE id=?').run('conv_cascade');
  assert.equal(snapshotCount('conv_cascade'), 0, 'deleting a conversation cascades its snapshots');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0, 'snapshots are not stored as messages');

  const prompt = systemPromptForRun();
  assert.equal(snapshotMatchesSystemPrompt([{ role: 'system', content: prompt }], prompt), true);
  assert.equal(snapshotMatchesSystemPrompt([{ role: 'system', content: `${prompt}\n` }], prompt), false, 'system prompt mismatch rejects restore');
  assert.equal(snapshotMatchesSystemPrompt([{ role: 'human', content: prompt }], prompt), false, 'restore requires the system message first');
  assert.equal(snapshotMatchesSystemPrompt([], prompt), false);

  insertConversation.run('conv_fill', 'user_a', 'fill', at(0), at(0));
  const insertMessage = db.prepare('INSERT INTO messages (id,user_id,conversation_id,role,content,status,created_at) VALUES (?,?,?,?,?,?,?)');
  insertMessage.run('m_cursor_user', 'user_a', 'conv_fill', 'user', 'cursor user', 'completed', at(1));
  insertMessage.run('m_cursor_ai', 'user_a', 'conv_fill', 'assistant', 'cursor assistant', 'completed', at(2));
  insertMessage.run('m_aaa', 'user_a', 'conv_fill', 'user', 'before tie', 'completed', at(2));
  insertMessage.run('m_zzz', 'user_a', 'conv_fill', 'user', 'after tie', 'completed', at(2));
  insertMessage.run('m_tool', 'user_a', 'conv_fill', 'tool', 'tool trace', 'completed', at(3));
  insertMessage.run('m_gap_user', 'user_a', 'conv_fill', 'user', 'gap user', 'completed', at(4));
  insertMessage.run('m_gap_ai', 'user_a', 'conv_fill', 'assistant', '<think>hidden</think>gap answer', 'completed', at(5));
  insertMessage.run('m_current', 'user_a', 'conv_fill', 'user', 'current user', 'completed', at(6));
  insertMessage.run('m_streaming', 'user_a', 'conv_fill', 'assistant', 'partial', 'streaming', at(7));
  const snapshotPrefix = [
    { role: 'system', content: prompt },
    { role: 'human', content: 'cursor user' },
    { role: 'ai', content: 'cursor assistant', reasoning_content: 'kept' },
  ];
  const supplemental = supplementalModelMessages({
    conversationId: 'conv_fill',
    userId: 'user_a',
    cursorTime: at(2),
    cursorId: 'm_cursor_ai',
    excludeMessageId: 'm_current',
  });
  assert.deepEqual(supplemental, [
    { role: 'human', content: 'after tie' },
    { role: 'human', content: 'gap user' },
    { role: 'ai', content: 'gap answer' },
  ], 'fill skips the current message, cursor message, earlier messages, tool rows, and hidden assistants');
  const restoredPrefix = [...snapshotPrefix, ...supplemental];
  assert.equal(restoredPrefix.filter(message => message.content === 'cursor user').length, 1, 'cursor message is not appended again');
  assert.equal(restoredPrefix.some(message => message.content === 'current user'), false);
  assert.equal(restoredPrefix.some(message => message.content === 'tool trace'), false);
  assert.equal(snapshotMatchesSystemPrompt([{ role: 'system', content: '其他系统提示' }, ...supplemental], prompt), false);

  const replay = new Map();
  const logged = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logged.push(args.map(item => String(item)).join(' ')); };
  let wireMessages;
  try {
    const modelTranscript = [
      { role: 'system', content: prompt },
      {
        role: 'human',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
      {
        role: 'ai',
        content: '',
        reasoning_content: 'need image',
        tool_calls: [{ id: 'call_img', name: 'view_image', arguments: '{ "id" : "att_1" }' }],
      },
      { role: 'tool', content: '已查看', tool_call_id: 'call_img' },
      {
        role: 'human',
        content: [
          { type: 'text', text: '这是通过 view_image 选中的历史图片（att_1）。' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
      { role: 'ai', content: '回答', reasoning_content: '' },
    ];
    const restoredMessages = restoreSnapshotMessages(modelTranscript, replay);
    assert.deepEqual(serializeAgentTranscript(restoredMessages), modelTranscript, 'snapshot transcript round-trips through LangChain');
    wireMessages = convertMessagesToCompletionsMessageParams({ messages: restoredMessages });
    const plainReplay = new Map();
    restoreSnapshotMessages([{ role: 'system', content: prompt }, { role: 'ai', content: 'plain' }], plainReplay);
    assert.equal(plainReplay.size, 0, 'missing reasoning is not invented');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(logged.some(line => line.includes(imageUrl) || line.includes('base64,')), false, 'base64 image payloads are not logged');
  const toolCallMessage = wireMessages.find(message => message.role === 'assistant' && message.tool_calls);
  assert.equal(toolCallMessage.tool_calls[0].function.arguments, '{ "id" : "att_1" }');
  assert.equal(replay.get(assistantReasoningReplayKey('', toolCallMessage.tool_calls)), 'need image');
  assert.equal(replay.get(assistantReasoningReplayKey('回答', null)), '');

  insertConversation.run('conv_inclusive', 'user_a', 'inclusive', at(0), at(0));
  const inclusiveEarly = createSnapshot('conv_inclusive', 'user_a', 'm1', at(1), [{ role: 'human', content: 'before cursor' }]);
  commitContextSnapshot({ snapshotId: inclusiveEarly.id, conversationId: 'conv_inclusive', userId: 'user_a' });
  const inclusiveCursor = createSnapshot('conv_inclusive', 'user_a', 'm2', at(2), [{ role: 'human', content: 'at cursor' }]);
  commitContextSnapshot({ snapshotId: inclusiveCursor.id, conversationId: 'conv_inclusive', userId: 'user_a' });
  const inclusiveLater = createSnapshot('conv_inclusive', 'user_a', 'm3', at(3), [{ role: 'ai', content: 'after cursor' }]);
  assert.equal(invalidateContextSnapshotsFromCursor({
    conversationId: 'conv_inclusive',
    userId: 'user_a',
    cursorTime: at(2),
    cursorId: 'm2',
  }), 2, 'invalidation includes the cursor snapshot and later snapshots');
  assert.equal(getContextSnapshot(inclusiveEarly.id, 'conv_inclusive', 'user_a')?.status, 'superseded');
  assert.equal(getContextSnapshot(inclusiveCursor.id, 'conv_inclusive', 'user_a')?.status, 'invalid');
  assert.equal(getContextSnapshot(inclusiveLater.id, 'conv_inclusive', 'user_a')?.status, 'invalid');
  assert.equal(getCurrentContextSnapshot('conv_inclusive', 'user_a'), undefined, 'inclusive invalidation does not resurrect an older snapshot');

  insertConversation.run('conv_tie_inclusive', 'user_a', 'tie inclusive', at(0), at(0));
  const tieEarly = createSnapshot('conv_tie_inclusive', 'user_a', 'm_early', at(4), [{ role: 'human', content: 'earlier time' }]);
  commitContextSnapshot({ snapshotId: tieEarly.id, conversationId: 'conv_tie_inclusive', userId: 'user_a' });
  const tieSmallerId = createSnapshot('conv_tie_inclusive', 'user_a', 'm0', at(5), [{ role: 'ai', content: 'same time, smaller id' }]);
  commitContextSnapshot({ snapshotId: tieSmallerId.id, conversationId: 'conv_tie_inclusive', userId: 'user_a' });
  assert.equal(invalidateContextSnapshotsFromCursor({
    conversationId: 'conv_tie_inclusive',
    userId: 'user_a',
    cursorTime: at(5),
    cursorId: 'm2',
  }), 1, 'same-timestamp snapshot is invalidated even when its id sorts first');
  assert.equal(getContextSnapshot(tieEarly.id, 'conv_tie_inclusive', 'user_a')?.status, 'superseded');
  assert.equal(getContextSnapshot(tieSmallerId.id, 'conv_tie_inclusive', 'user_a')?.status, 'invalid');

  insertConversation.run('conv_replace', 'user_a', 'replace', at(0), at(0));
  insertMessage.run('repl_u', 'user_a', 'conv_replace', 'user', 'replace me', 'completed', at(2));
  insertMessage.run('repl_a', 'user_a', 'conv_replace', 'assistant', 'old answer', 'completed', at(3));
  const replaceEarly = createSnapshot('conv_replace', 'user_a', 'repl_early', at(1), [{ role: 'human', content: 'older context' }]);
  commitContextSnapshot({ snapshotId: replaceEarly.id, conversationId: 'conv_replace', userId: 'user_a' });
  const replaceUser = createSnapshot('conv_replace', 'user_a', 'repl_u', at(2), [{ role: 'human', content: 'replace me' }]);
  commitContextSnapshot({ snapshotId: replaceUser.id, conversationId: 'conv_replace', userId: 'user_a' });
  const replaceAssistant = createSnapshot('conv_replace', 'user_a', 'repl_a', at(3), [{ role: 'ai', content: 'old answer' }]);
  commitContextSnapshot({ snapshotId: replaceAssistant.id, conversationId: 'conv_replace', userId: 'user_a' });
  replaceLatestMessagePair({
    conversationId: 'conv_replace',
    userId: 'user_a',
    userMessageId: 'repl_u',
    userContent: 'replaced',
    newAssistantId: 'repl_a2',
    referencedAssistantAttachmentIds: [],
  });
  assert.equal(getContextSnapshot(replaceEarly.id, 'conv_replace', 'user_a')?.status, 'superseded', 'editing the latest message keeps earlier snapshots');
  assert.equal(getContextSnapshot(replaceUser.id, 'conv_replace', 'user_a')?.status, 'invalid');
  assert.equal(getContextSnapshot(replaceAssistant.id, 'conv_replace', 'user_a')?.status, 'invalid');

  insertConversation.run('conv_delete_pair', 'user_a', 'delete pair', at(0), at(0));
  insertMessage.run('del_u1', 'user_a', 'conv_delete_pair', 'user', 'keep', 'completed', at(1));
  insertMessage.run('del_a1', 'user_a', 'conv_delete_pair', 'assistant', 'keep answer', 'completed', at(2));
  insertMessage.run('del_u2', 'user_a', 'conv_delete_pair', 'user', 'drop', 'completed', at(3));
  insertMessage.run('del_a2', 'user_a', 'conv_delete_pair', 'assistant', 'drop answer', 'completed', at(4));
  const deleteEarly = createSnapshot('conv_delete_pair', 'user_a', 'del_a1', at(2), [{ role: 'ai', content: 'keep answer' }]);
  commitContextSnapshot({ snapshotId: deleteEarly.id, conversationId: 'conv_delete_pair', userId: 'user_a' });
  const deleteCursor = createSnapshot('conv_delete_pair', 'user_a', 'del_u2', at(3), [{ role: 'human', content: 'drop' }]);
  commitContextSnapshot({ snapshotId: deleteCursor.id, conversationId: 'conv_delete_pair', userId: 'user_a' });
  const deleted = deleteMessagePairData({
    conversationId: 'conv_delete_pair',
    userId: 'user_a',
    userMessageId: 'del_u2',
    referencedAttachmentIds: [],
  });
  assert.equal(deleted.conversationDeleted, false);
  assert.equal(getContextSnapshot(deleteEarly.id, 'conv_delete_pair', 'user_a')?.status, 'superseded');
  assert.equal(getContextSnapshot(deleteCursor.id, 'conv_delete_pair', 'user_a')?.status, 'invalid');
  assert.equal(snapshotCount('conv_delete_pair'), 2, 'pair deletion does not copy snapshot rows');

  insertConversation.run('conv_append', 'user_a', 'append', at(0), at(0));
  insertMessage.run('app_u1', 'user_a', 'conv_append', 'user', 'history question', 'completed', at(1));
  insertMessage.run('app_a1', 'user_a', 'conv_append', 'assistant', 'history answer', 'completed', at(2));
  insertMessage.run('app_u2', 'user_a', 'conv_append', 'user', 'latest question', 'completed', at(3));
  insertMessage.run('app_a2', 'user_a', 'conv_append', 'assistant', 'latest answer', 'completed', at(4));
  const appendCurrent = createSnapshot('conv_append', 'user_a', 'app_a2', at(4), [{ role: 'ai', content: 'latest answer' }]);
  const appendPublished = commitContextSnapshot({ snapshotId: appendCurrent.id, conversationId: 'conv_append', userId: 'user_a' });
  appendEditedMessagePair({
    conversationId: 'conv_append',
    userId: 'user_a',
    originalUserMessageId: 'app_u1',
    userMessageId: 'app_u3',
    assistantId: 'app_a3',
    userContent: 'appended question',
    attachmentIds: [],
  });
  assert.deepEqual(getCurrentContextSnapshot('conv_append', 'user_a'), appendPublished, 'appending a historical edit does not invalidate snapshots');

  insertConversation.run('conv_compact', 'user_a', 'compact', at(0), at(0));
  insertConversation.run('conv_compact_other', 'user_a', 'compact other', at(0), at(0));
  insertMessage.run('cmp_u1', 'user_a', 'conv_compact', 'user', 'old question', 'completed', at(0));
  insertMessage.run('cmp_a1', 'user_a', 'conv_compact', 'assistant', 'old answer', 'completed', at(1));
  insertMessage.run('cmp_u2', 'user_a', 'conv_compact', 'user', 'current question', 'completed', at(1000));
  const compactOld = createSnapshot('conv_compact', 'user_a', 'cmp_u1', at(0), [{ role: 'human', content: 'old question' }]);
  commitContextSnapshot({ snapshotId: compactOld.id, conversationId: 'conv_compact', userId: 'user_a' });
  const compactCurrent = createSnapshot('conv_compact', 'user_a', 'cmp_a1', at(1), [{ role: 'ai', content: 'old answer' }]);
  commitContextSnapshot({ snapshotId: compactCurrent.id, conversationId: 'conv_compact', userId: 'user_a' });
  const compactPending = createSnapshot('conv_compact', 'user_a', 'cmp_u2', at(1000), [{ role: 'human', content: 'current question' }]);
  const compactOther = createSnapshot('conv_compact_other', 'user_a', 'cmp_other', at(1), [{ role: 'human', content: 'leave me' }]);
  const compactOtherCurrent = commitContextSnapshot({ snapshotId: compactOther.id, conversationId: 'conv_compact_other', userId: 'user_a' });
  const savedKeys = ['TITLE_API_KEY', 'MODEL_API_KEY', 'OPENAI_API_KEY'].map(name => [name, process.env[name]]);
  for (const [name] of savedKeys) delete process.env[name];
  try {
    await prepareConversationContext({
      userId: 'user_a',
      conversationId: 'conv_compact',
      currentMessageId: 'cmp_u2',
      requestAt: at(1000),
    });
  } finally {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(getContextSnapshot(compactOld.id, 'conv_compact', 'user_a')?.status, 'invalid');
  assert.equal(getContextSnapshot(compactCurrent.id, 'conv_compact', 'user_a')?.status, 'invalid');
  assert.equal(getContextSnapshot(compactPending.id, 'conv_compact', 'user_a')?.status, 'invalid');
  assert.equal(getCurrentContextSnapshot('conv_compact', 'user_a'), undefined, 'summary compaction invalidates every snapshot');
  assert.deepEqual(getCurrentContextSnapshot('conv_compact_other', 'user_a'), compactOtherCurrent, 'compaction stays inside the conversation');

  console.info('conversation context snapshot sanity passed');
} finally {
  db.close();
  closeRagDb();
  await rm(tempDir, { recursive: true, force: true });
}
