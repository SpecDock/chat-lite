import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const readSource = (relativePath) => readFile(new URL(relativePath, import.meta.url), 'utf8');

async function importSourceFunction(relativePath, functionName, scriptKind) {
  const source = await readSource(relativePath);
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const declaration = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  );
  assert.ok(declaration, `${functionName} must be a top-level function`);
  const output = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const [searchSource, listSource, pageSource, messageListSource, clientSource, styles] = await Promise.all([
  readSource('../src/web/features/chat/ConversationSearch.tsx'),
  readSource('../src/web/features/chat/ConversationList.tsx'),
  readSource('../src/web/features/chat/ChatPage.tsx'),
  readSource('../src/web/features/chat/MessageList.tsx'),
  readSource('../src/web/shared/api/client.ts'),
  readSource('../src/web/styles.css'),
]);

const { splitHighlightParts } = await importSourceFunction(
  '../src/web/features/chat/ConversationSearch.tsx',
  'splitHighlightParts',
  ts.ScriptKind.TSX
);
assert.deepEqual(splitHighlightParts('Alpha a+b ALPHA', 'alpha'), [
  { text: 'Alpha', highlighted: true },
  { text: ' a+b ', highlighted: false },
  { text: 'ALPHA', highlighted: true },
]);
assert.deepEqual(splitHighlightParts('<script>a+b</script>', 'a+b'), [
  { text: '<script>', highlighted: false },
  { text: 'a+b', highlighted: true },
  { text: '</script>', highlighted: false },
], 'highlighting treats HTML and regexp characters as plain text');

const { buildSearchMessagesUrl } = await importSourceFunction(
  '../src/web/shared/api/client.ts',
  'buildSearchMessagesUrl',
  ts.ScriptKind.TS
);
assert.equal(buildSearchMessagesUrl(' 中文 & coral ', 30), '/api/search/messages?q=+%E4%B8%AD%E6%96%87+%26+coral+&offset=30&limit=30');

const blankGuard = searchSource.indexOf('if (!normalizedQuery) return;');
const debounceCall = searchSource.indexOf('window.setTimeout');
assert.ok(blankGuard >= 0 && blankGuard < debounceCall, 'blank trimmed queries return before scheduling the API call');
assert.match(searchSource, /const SEARCH_DEBOUNCE_MS = 250/);
assert.match(searchSource, /new AbortController\(\)/);
assert.match(searchSource, /requestRef\.current\?\.abort\(\)/);
assert.match(searchSource, /api\.searchMessages\(normalizedQuery, offset, controller\.signal\)/);
assert.match(searchSource, /requestGenerationRef/);
assert.match(searchSource, /cause instanceof Error && cause\.name === 'AbortError'/);
assert.match(searchSource, /new RegExp\(escapedNeedle, 'giu'\)/);

assert.match(clientSource, /limit: '30'/);
assert.match(clientSource, /fetch\(buildSearchMessagesUrl\(q, offset\), \{ credentials: 'include', signal \}\)/);
assert.match(searchSource, /response\.nextOffset/);
assert.match(searchSource, /response\.hasMore/);
assert.match(searchSource, /<= 160/);
assert.match(searchSource, /inFlightRef\.current\.has\(requestKey\)/);
assert.match(searchSource, /known\.has\(result\.messageId\)/);

assert.doesNotMatch(searchSource, /dangerouslySetInnerHTML/);
assert.match(searchSource, /<mark>\{part\.text\}<\/mark> : part\.text/);
assert.match(searchSource, /role="dialog" aria-modal="true" aria-label="搜索消息"/);
assert.match(searchSource, /aria-live="polite"/);
assert.match(searchSource, /event\.key === 'Escape'/);
assert.match(searchSource, /triggerRef\.current\?\.focus/);
assert.match(searchSource, /inputRef\.current\?\.focus/);

const triggerIndex = listSource.indexOf('conversation-search-trigger');
const newConversationIndex = listSource.indexOf('new-conv');
assert.ok(triggerIndex >= 0 && triggerIndex < newConversationIndex, 'search trigger precedes the new-conversation button');
assert.match(listSource, /import \{ Search \} from 'lucide-react'/);
assert.match(listSource, />搜索消息</);
assert.doesNotMatch(listSource + searchSource, /metaKey|ctrlKey|Ctrl|Cmd|⌘/);

assert.match(pageSource, /searchOpen/);
assert.match(pageSource, /type JumpTarget = \{ conversationId: string; messageId: string \}/);
assert.match(pageSource, /setDrawer\(false\)/);
assert.match(pageSource, /cachedMessages\?\.some\(message => message\.id === result\.messageId\)/);
assert.match(pageSource, /searchSelectionRef/);
assert.match(pageSource, /isSelectionActive/);
assert.match(pageSource, /isViewCurrent/);
assert.match(pageSource, /setConversationError\(conversationId, '消息已不存在'\)/);
assert.match(pageSource, /jumpMessageId=/);
assert.match(pageSource, /onJumpComplete=/);

assert.match(messageListSource, /jumpMessageId\?: string/);
assert.match(messageListSource, /onJumpComplete\?: \(found: boolean\) => void/);
assert.match(messageListSource, /completed = false/);
assert.match(messageListSource, /if \(jumpMessageId\) return/);
assert.match(messageListSource, /data-message-id=\{message\.id\}/);
assert.match(messageListSource, /scrollIntoView\(\{ block: 'center', behavior: reduce \? 'auto' : 'smooth' \}\)/);
assert.match(messageListSource, /useGSAP\(/);
assert.match(messageListSource, /rgba\(204, 120, 92/);
assert.match(messageListSource, /gsap\.delayedCall\(2, complete\)/);
assert.match(messageListSource, /revertOnUpdate: true/);

assert.match(styles, /\.conversation-search\s*\{[\s\S]*?width: min\(760px, calc\(100vw - 48px\)\);[\s\S]*?max-height: 75dvh;/);
assert.match(styles, /@media \(max-width: 799px\) \{[\s\S]*?\.conversation-search\s*\{[\s\S]*?height: 100dvh;[\s\S]*?height: 100%;[\s\S]*?border-radius: 0;/);
assert.match(styles, /@media \(min-width: 800px\)/);
assert.match(styles, /env\(safe-area-inset-top\)/);
assert.match(styles, /env\(safe-area-inset-bottom\)/);
assert.match(styles, /--conversation-search-viewport-height/);
assert.match(styles, /\.conversation-search-trigger\s*\{[\s\S]*?min-height: 44px;/);
assert.match(styles, /\.conversation-search-results\s*\{[\s\S]*?overflow-x: hidden;/);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);

console.info('search UI sanity passed');
