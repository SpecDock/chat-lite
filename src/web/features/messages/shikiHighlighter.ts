import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs';

export const SHIKI_THEME_NAME = 'chat-lite-typora-light';
export const chatLiteTyporaLight: ThemeRegistration = {
  name: SHIKI_THEME_NAME,
  type: 'light',
  colors: {
    'editor.background': '#f7f7f7',
    'editor.foreground': '#292a2a',
  },
  settings: [
    { settings: { foreground: '#292a2a', background: '#f7f7f7' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#92552d', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.modifier', 'entity.name.tag'], settings: { foreground: '#7a007a' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#0f6d65' } },
    { scope: ['entity.name.function', 'support.function', 'variable.function', 'meta.function-call'], settings: { foreground: '#1f6f5f' } },
    { scope: ['string', 'constant.other.symbol', 'markup.inline.raw'], settings: { foreground: '#174f78' } },
    { scope: ['constant.numeric', 'constant.language', 'support.constant'], settings: { foreground: '#006c73' } },
    { scope: ['keyword.operator', 'punctuation.accessor', 'punctuation.separator.key-value', 'punctuation.definition.tag', 'punctuation.definition.template-expression', 'meta.brace'], settings: { foreground: '#b4232f' } },
    { scope: ['variable', 'meta.object-literal.key', 'entity.other.attribute-name'], settings: { foreground: '#292a2a' } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: '#a61b29' } },
  ],
};

const manualAliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  sh: 'shellscript',
  shell: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  cc: 'cpp',
  'c++': 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  csharp: 'csharp',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  plaintext: 'plaintext',
};

const aliases = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  aliases.set(info.id.toLowerCase(), info.id);
  for (const alias of info.aliases || []) aliases.set(alias.toLowerCase(), info.id);
}
for (const [alias, language] of Object.entries(manualAliases)) aliases.set(alias, language);

export type ResolvedShikiLanguage = {
  id: string;
  known: boolean;
  label: string;
};

export function resolveShikiLanguage(language?: string): ResolvedShikiLanguage {
  const requested = String(language || '').trim().toLowerCase().replace(/^language-/, '');
  const id = aliases.get(requested) || 'plaintext';
  const known = Boolean(requested) && id !== 'plaintext' && id in bundledLanguages;
  return { id: known ? id : 'plaintext', known, label: known ? id.toUpperCase() : 'TEXT' };
}

let highlighterPromise: Promise<HighlighterCore> | undefined;
const languagePromises = new Map<string, Promise<HighlighterCore>>();

export function getShikiHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [chatLiteTyporaLight],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  }
  return highlighterPromise;
}

export function loadShikiLanguage(language?: string): Promise<{ highlighter: HighlighterCore; language: ResolvedShikiLanguage } | null> {
  const resolved = resolveShikiLanguage(language);
  if (!resolved.known) return Promise.resolve(null);

  let loading = languagePromises.get(resolved.id);
  if (!loading) {
    loading = getShikiHighlighter().then(async highlighter => {
      if (!highlighter.getLoadedLanguages().includes(resolved.id)) {
        await highlighter.loadLanguage(bundledLanguages[resolved.id as keyof typeof bundledLanguages]);
      }
      return highlighter;
    });
    languagePromises.set(resolved.id, loading);
  }
  return loading.then(highlighter => ({ highlighter, language: resolved }));
}
