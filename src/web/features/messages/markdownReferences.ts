import type MarkdownIt from 'markdown-it';
import type { StreamingMarkdownBlock } from './streamingMarkdownParser';

export type ReferenceDefinition = {
  label: string;
  source: string;
};

type MarkdownEnvironment = {
  references?: Record<string, { href: string; title?: string }>;
};

function definitionSource(label: string, href: string, title?: string) {
  const safeLabel = label.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  const safeHref = href.replace(/\\/g, '\\\\').replace(/>/g, '\\>');
  const safeTitle = title?.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  return `[${safeLabel}]: <${safeHref}>${safeTitle === undefined ? '' : ` "${safeTitle}"`}`;
}

export function collectMarkdownReferenceDefinitions(md: MarkdownIt, blocks: StreamingMarkdownBlock[]) {
  const definitions = new Map<string, ReferenceDefinition>();
  for (const block of blocks) {
    if (block.type !== 'markdown') continue;
    const environment: MarkdownEnvironment = {};
    try {
      md.parse(block.content, environment);
    } catch (error) {
      console.warn('[chat-lite] markdown reference scan skipped', error);
      continue;
    }
    for (const [label, definition] of Object.entries(environment.references || {})) {
      if (!definitions.has(label)) {
        definitions.set(label, {
          label,
          source: definitionSource(label, definition.href, definition.title),
        });
      }
    }
  }
  return [...definitions.values()];
}

export function appendReferenceDefinitions(content: string, definitions: ReferenceDefinition[]) {
  if (definitions.length === 0) return content;
  const source = definitions.map(definition => definition.source).join('\n');
  return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${source}\n`;
}
