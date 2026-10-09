import assert from 'node:assert/strict';

const { selectModelVisibleHistory } = await import('../src/server/domain/chat/message-visibility.ts');
const assistant = (content, status = 'completed') => ({ role: 'assistant', content, status });
const user = (content) => ({ role: 'user', content, status: 'completed' });

const failures = [
  '当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。',
  '当前主模型连接被中断（上游服务不稳定或请求超时）。已自动尝试 2 次仍失败，请稍后重试。',
  '当前主模型调用失败，请稍后重试。',
  '主模型未返回正文，请尝试重新提问或调整描述。'
];
assert.deepEqual(selectModelVisibleHistory([assistant('正文', 'error')], 6), [], 'error is excluded');
for (const failure of failures) assert.deepEqual(selectModelVisibleHistory([assistant(failure)], 6), [], `failure placeholder excluded: ${failure}`);
assert.deepEqual(selectModelVisibleHistory([assistant('<think>internal</think>')], 6), [], 'think-only is excluded');
assert.deepEqual(selectModelVisibleHistory([assistant('已取消', 'interrupted')], 6), [], 'cancel-only interruption is excluded');
assert.equal(selectModelVisibleHistory([assistant('<think>x</think>保留正文', 'interrupted')], 6).length, 1, 'interrupted body is retained');
assert.equal(selectModelVisibleHistory([user('失败前的问题'), assistant(failures[0])], 6).length, 1, 'user question before failure is retained');
assert.equal(selectModelVisibleHistory([assistant('![图](/api/files/att_real)')], 6).length, 1, 'image markdown is retained');
const interleaved = [user('1'), assistant(failures[0]), user('2'), assistant('<think>x</think>'), user('3'), assistant('已取消', 'interrupted'), user('4'), assistant('有效'), user('5'), assistant('有效2')];
assert.deepEqual(selectModelVisibleHistory(interleaved, 6).map(m => m.content), ['1', '2', '3', '4', '有效', '5', '有效2'].slice(-6), 'invalid middle messages still permit six valid history entries');
console.info('message visibility sanity passed');
