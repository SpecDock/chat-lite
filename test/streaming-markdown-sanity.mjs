import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { parseStreamingMarkdown } from '../src/web/features/messages/streamingMarkdownParser.ts';
import {
  appendReferenceDefinitions,
  collectMarkdownReferenceDefinitions,
} from '../src/web/features/messages/markdownReferences.ts';
import { splitThinkBlocks } from '../src/web/features/messages/thinkBlocks.ts';

const multiple = parseStreamingMarkdown('before\n```ts\nconst a = 1;\n```\nbetween\n~~~python\nprint("x")\n~~~~~\nafter');
assert.deepEqual(multiple.map(block => block.type), ['markdown', 'code', 'markdown', 'code', 'markdown']);
assert.deepEqual(multiple.filter(block => block.type === 'code').map(block => ({ raw: block.raw, lang: block.lang, closed: block.closed, index: block.blockIndex })), [
  { raw: 'const a = 1;\n', lang: 'ts', closed: true, index: 0 },
  { raw: 'print("x")\n', lang: 'python', closed: true, index: 1 },
]);

const noLanguage = parseStreamingMarkdown('```\nraw <&>\n```');
assert.equal(noLanguage[0].type, 'code');
assert.equal(noLanguage[0].lang, '');
assert.equal(noLanguage[0].raw, 'raw <&>\n');
assert.equal(noLanguage[0].closed, true);

const interrupted = parseStreamingMarkdown('text\n```js\nconst exact = `a\\nb`;\nno trailing newline');
assert.equal(interrupted[1].type, 'code');
assert.equal(interrupted[1].raw, 'const exact = `a\\nb`;\nno trailing newline');
assert.equal(interrupted[1].closed, false);

const partialOpening = parseStreamingMarkdown('prefix\n```type');
assert.deepEqual(partialOpening, [{ type: 'markdown', key: 'markdown-0', content: 'prefix\n```type' }]);

const inline = parseStreamingMarkdown('Use `const x = 1` inline.\nAnd ``two ticks``.');
assert.equal(inline.length, 1);
assert.equal(inline[0].type, 'markdown');

const wrongClosing = parseStreamingMarkdown('~~~js\na\n```\nb\n~~~');
assert.equal(wrongClosing[0].type, 'code');
assert.equal(wrongClosing[0].raw, 'a\n```\nb\n');
assert.equal(wrongClosing[0].closed, true);

for (const nested of [
  '  ```js\nconst nested = true;\n  ```',
  '> ```js\n> const quoted = true;\n> ```',
  '- item\n  ```js\n  const listed = true;\n  ```',
]) {
  const parsed = parseStreamingMarkdown(nested);
  assert.deepEqual(parsed, [{ type: 'markdown', key: 'markdown-0', content: nested }]);
}

const crlf = parseStreamingMarkdown('before\r\n```ts\r\nconst crlf = true;\r\n```\r\nafter');
assert.equal(crlf[1].type, 'code');
assert.equal(crlf[1].raw, 'const crlf = true;\r\n');
assert.equal(crlf[1].closed, true);

const referenceSource = '[documentation][docs]\n\n```text\nraw\n```\n\n[docs]: https://example.com "Docs"';
const referenceBlocks = parseStreamingMarkdown(referenceSource);
const referenceMarkdown = new MarkdownIt();
const definitions = collectMarkdownReferenceDefinitions(referenceMarkdown, referenceBlocks);
assert.equal(definitions.length, 1);
const firstMarkdown = referenceBlocks.find(block => block.type === 'markdown');
const referenceHtml = referenceMarkdown.render(appendReferenceDefinitions(firstMarkdown.content, definitions));
assert.match(referenceHtml, /href="https:\/\/example\.com"/);
assert.equal(referenceHtml.includes('[docs]:'), false, 'reference definitions stay non-rendering');

const multiLineReference = parseStreamingMarkdown('[multi]\n```text\nx\n```\n[multi]:\n  <https://example.com/multi>\n  "Multi title"');
const multiLineDefinitions = collectMarkdownReferenceDefinitions(referenceMarkdown, multiLineReference);
assert.equal(multiLineDefinitions.length, 1);
assert.match(referenceMarkdown.render(appendReferenceDefinitions(multiLineReference[0].content, multiLineDefinitions)), /href="https:\/\/example\.com\/multi"/);

const prefixSource = 'prefix\n```ts\nconst value = 1;\n```\nsuffix';
const openingEnd = prefixSource.indexOf('\n', prefixSource.indexOf('```')) + 1;
for (let length = 0; length <= prefixSource.length; length += 1) {
  const prefix = prefixSource.slice(0, length);
  const parsed = parseStreamingMarkdown(prefix);
  if (length < openingEnd) {
    assert.deepEqual(parsed, prefix ? [{ type: 'markdown', key: 'markdown-0', content: prefix }] : []);
  } else {
    assert.equal(parsed.some(block => block.type === 'code'), true, `code block at prefix ${length}`);
  }
}

const stablePrefix = parseStreamingMarkdown('alpha\n```ts\nlet a = 1;');
const stableAppended = parseStreamingMarkdown('alpha\n```ts\nlet a = 1;\n```\nomega');
assert.equal(stablePrefix[0].key, stableAppended[0].key);
assert.equal(stablePrefix[1].key, stableAppended[1].key);

assert.deepEqual(splitThinkBlocks('  before\n<think>reason</think>\n```ts\ncode\n```  '), {
  thinking: 'reason',
  answer: '  before\n\n```ts\ncode\n```  ',
  sawThinkTag: true,
});
assert.deepEqual(splitThinkBlocks('<think></think>answer'), {
  thinking: '', answer: 'answer', sawThinkTag: true,
});
assert.deepEqual(splitThinkBlocks('a<think> one </think>b<think>two</think>c'), {
  thinking: 'one\n\ntwo', answer: 'abc', sawThinkTag: true,
});
assert.deepEqual(splitThinkBlocks('  untouched  '), {
  thinking: '', answer: '  untouched  ', sawThinkTag: false,
});

console.info('streaming markdown sanity passed');
