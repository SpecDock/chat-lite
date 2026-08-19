import assert from 'node:assert/strict';
import { ShikiStreamTokenizer } from '@shikijs/stream';
import {
  SHIKI_MAX_BYTES,
  applyTokenRecall,
  importIfShikiSupported,
  shouldUseShiki,
  utf8ByteLength,
} from '../src/web/features/messages/codeBlockHelpers.ts';
import {
  SHIKI_THEME_NAME,
  loadShikiLanguage,
  resolveShikiLanguage,
} from '../src/web/features/messages/shikiHighlighter.ts';

const loaded = await loadShikiLanguage('typescript');
assert.ok(loaded, 'typescript must initialize the Oniguruma highlighter');
assert.equal(loaded.language.id, 'typescript');
assert.ok(loaded.highlighter.getLoadedLanguages().includes('typescript'));

const tokenizer = new ShikiStreamTokenizer({
  highlighter: loaded.highlighter,
  lang: loaded.language.id,
  theme: SHIKI_THEME_NAME,
});
const rawCode = 'const value: string = "hello"\nconsole.log(value)';
const chunks = [...rawCode];
let tokens = [];
let sawRecall = false;
for (const chunk of chunks) {
  const update = await tokenizer.enqueue(chunk);
  sawRecall ||= update.recall > 0;
  tokens = applyTokenRecall(tokens, update);
}
assert.equal(tokens.map(token => token.content).join(''), chunks.join(''));
assert.equal(sawRecall, true, 'split chunks on an unstable line must exercise recall');
tokenizer.clear();
tokens = [];
for (const chunk of ['let reset', ' = true']) {
  tokens = applyTokenRecall(tokens, await tokenizer.enqueue(chunk));
}
assert.equal(tokens.map(token => token.content).join(''), 'let reset = true');
tokenizer.close();

assert.deepEqual(resolveShikiLanguage('TS'), { id: 'typescript', known: true, label: 'TYPESCRIPT' });
for (const [alias, expected] of [
  ['js', 'javascript'], ['jsx', 'jsx'], ['tsx', 'tsx'], ['sh', 'shellscript'], ['shell', 'shellscript'],
  ['cpp', 'cpp'], ['csharp', 'csharp'],
]) {
  assert.equal(resolveShikiLanguage(alias).id, expected, `${alias} alias`);
}
assert.deepEqual(resolveShikiLanguage('not-a-real-language'), { id: 'plaintext', known: false, label: 'TEXT' });
assert.deepEqual(resolveShikiLanguage(''), { id: 'plaintext', known: false, label: 'TEXT' });
assert.equal(utf8ByteLength('中'), 3);
assert.equal(utf8ByteLength('😀'), 4);
assert.equal(shouldUseShiki('x'.repeat(SHIKI_MAX_BYTES)), true);
assert.equal(shouldUseShiki('x'.repeat(SHIKI_MAX_BYTES + 1)), false);
assert.equal(shouldUseShiki(`${'x'.repeat(SHIKI_MAX_BYTES - 3)}中`), true);
assert.equal(shouldUseShiki(`${'x'.repeat(SHIKI_MAX_BYTES - 3)}中x`), false);
assert.equal(shouldUseShiki(`${'x'.repeat(SHIKI_MAX_BYTES - 4)}😀`), true);

let unsupportedImportCalls = 0;
const unsupported = await importIfShikiSupported(
  { TransformStream: undefined, WebAssembly: {} },
  async () => { unsupportedImportCalls += 1; return 'loaded'; },
);
assert.equal(unsupported, null);
assert.equal(unsupportedImportCalls, 0, 'missing TransformStream must prevent dynamic import');

console.info('shiki stream sanity passed');
