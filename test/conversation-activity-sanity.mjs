import assert from 'node:assert/strict';
import {
  clearConversationUnread,
  migrateConversationActivity,
  parseUnreadActivities,
  serializeUnreadActivities,
  transitionConversationActivity
} from '../src/web/features/chat/conversationActivity.ts';

let activities = transitionConversationActivity({}, 'conversation-a', 'streaming', false);
assert.deepEqual(activities['conversation-a'], { status: 'streaming', unread: false });

activities = transitionConversationActivity(activities, 'conversation-a', 'completed', false);
assert.deepEqual(activities['conversation-a'], { status: 'completed', unread: true });
activities = clearConversationUnread(activities, 'conversation-a');
assert.deepEqual(activities['conversation-a'], { status: 'completed', unread: false });

activities = transitionConversationActivity(activities, 'conversation-b', 'error', false);
const persisted = parseUnreadActivities(serializeUnreadActivities(activities));
assert.deepEqual(persisted, { 'conversation-b': { status: 'error', unread: true } });

activities = transitionConversationActivity(activities, 'temporary-1', 'streaming', false);
activities = migrateConversationActivity(activities, 'temporary-1', 'conversation-real');
assert.equal(activities['temporary-1'], undefined);
assert.deepEqual(activities['conversation-real'], { status: 'streaming', unread: false });

console.info('conversation activity sanity passed');
