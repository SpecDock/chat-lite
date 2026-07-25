import assert from 'node:assert/strict';
import {
  drainConversationDelta,
  enqueueConversationDelta,
  normalizeStreamingMarkdownInterval,
} from '../src/web/features/chat/conversationDeltaBuffer.ts';

const callbacks = new Map();
const cancelled = [];
let nextHandle = 1;
const scheduler = {
  schedule(callback) {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  },
  cancel(handle) {
    cancelled.push(handle);
    callbacks.delete(handle);
  },
};

const buffer = { pendingDelta: '', deltaFlushHandle: null };
const flushed = [];
const flush = () => {
  const pending = drainConversationDelta(buffer, scheduler);
  if (pending) flushed.push(pending);
};

assert.equal(enqueueConversationDelta(buffer, { text: 'A', targetKey: 'one', assistantId: 'a' }, scheduler, flush), true);
assert.equal(enqueueConversationDelta(buffer, { text: 'B', targetKey: 'one', assistantId: 'a' }, scheduler, flush), true);
assert.equal(callbacks.size, 1, 'same-cycle deltas share one scheduled flush');
const [scheduledHandle, scheduledCallback] = callbacks.entries().next().value;
callbacks.delete(scheduledHandle);
scheduledCallback();
assert.deepEqual(flushed, [{ text: 'AB', targetKey: 'one', assistantId: 'a' }]);

assert.equal(enqueueConversationDelta(buffer, { text: 'C', targetKey: 'two', assistantId: 'b' }, scheduler, flush), true);
const terminalPending = drainConversationDelta(buffer, scheduler);
assert.deepEqual(terminalPending, { text: 'C', targetKey: 'two', assistantId: 'b' });
assert.equal(callbacks.size, 0, 'terminal drain cancels the pending flush');
assert.ok(cancelled.length > 0);

assert.equal(enqueueConversationDelta(buffer, { text: 'old', targetKey: 'old', assistantId: 'temp' }, scheduler, flush), true);
assert.equal(enqueueConversationDelta(buffer, { text: 'new', targetKey: 'new', assistantId: 'real' }, scheduler, flush), false, 'target changes require an ordered flush');
assert.deepEqual(drainConversationDelta(buffer, scheduler), { text: 'old', targetKey: 'old', assistantId: 'temp' });

const firstConversation = { pendingDelta: '', deltaFlushHandle: null };
const secondConversation = { pendingDelta: '', deltaFlushHandle: null };
assert.equal(enqueueConversationDelta(firstConversation, { text: 'one', targetKey: 'one', assistantId: 'a' }, scheduler, () => undefined), true);
assert.equal(enqueueConversationDelta(secondConversation, { text: 'two', targetKey: 'two', assistantId: 'b' }, scheduler, () => undefined), true);
assert.notEqual(firstConversation.deltaFlushHandle, secondConversation.deltaFlushHandle);
assert.deepEqual(drainConversationDelta(firstConversation, scheduler), { text: 'one', targetKey: 'one', assistantId: 'a' });
assert.deepEqual(drainConversationDelta(secondConversation, scheduler), { text: 'two', targetKey: 'two', assistantId: 'b' });

assert.equal(normalizeStreamingMarkdownInterval(undefined), 50);
assert.equal(normalizeStreamingMarkdownInterval('75'), 75);
assert.equal(normalizeStreamingMarkdownInterval('invalid'), 50);
assert.equal(normalizeStreamingMarkdownInterval('1'), 16);
assert.equal(normalizeStreamingMarkdownInterval('5000'), 1000);

console.info('conversation delta buffer sanity passed');
