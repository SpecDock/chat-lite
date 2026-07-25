import assert from 'node:assert/strict';
import { splitThinkBlocks } from '../src/web/features/messages/thinkBlocks.ts';

const plain = splitThinkBlocks('  plain answer\n');
assert.deepEqual(plain, {
  thinking: '',
  answer: '  plain answer\n',
  sawThinkTag: false,
});

const fenced = splitThinkBlocks('<think>inspect</think>\n\n```ts\n  const value = 1;\n```\n');
assert.equal(fenced.thinking, 'inspect');
assert.equal(fenced.answer, '\n\n```ts\n  const value = 1;\n```\n');
assert.equal(fenced.sawThinkTag, true);

const empty = splitThinkBlocks('<think></think>\n\nanswer');
assert.equal(empty.thinking, '');
assert.equal(empty.answer, '\n\nanswer');
assert.equal(empty.sawThinkTag, true);

const multiple = splitThinkBlocks('before<think> first </think>middle<think>second</think>after');
assert.equal(multiple.thinking, 'first\n\nsecond');
assert.equal(multiple.answer, 'beforemiddleafter');

const unfinished = splitThinkBlocks('<think>still working');
assert.equal(unfinished.thinking, 'still working');
assert.equal(unfinished.answer, '');
assert.equal(unfinished.sawThinkTag, true);

console.info('think blocks sanity passed');
