export type MarkdownBlock = {
  type: 'markdown';
  key: string;
  content: string;
};

export type CodeBlock = {
  type: 'code';
  key: string;
  raw: string;
  lang: string;
  closed: boolean;
  blockIndex: number;
};

export type StreamingMarkdownBlock = MarkdownBlock | CodeBlock;

type SourceLine = {
  start: number;
  body: string;
  next: number;
  hasEnding: boolean;
};

function readLine(source: string, start: number): SourceLine {
  const newline = source.indexOf('\n', start);
  if (newline === -1) {
    return { start, body: source.slice(start), next: source.length, hasEnding: false };
  }
  const bodyEnd = newline > start && source[newline - 1] === '\r' ? newline - 1 : newline;
  return { start, body: source.slice(start, bodyEnd), next: newline + 1, hasEnding: true };
}

function openingFence(line: SourceLine) {
  if (!line.hasEnding) return undefined;
  const match = /^(`{3,}|~{3,})(.*)$/.exec(line.body);
  if (!match) return undefined;
  const marker = match[1];
  const info = match[2].trim();
  if (marker[0] === '`' && info.includes('`')) return undefined;
  return {
    marker: marker[0],
    length: marker.length,
    lang: info.split(/[ \t]+/, 1)[0] || '',
  };
}

function isClosingFence(line: SourceLine, marker: string, minimumLength: number) {
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(line.body);
  return Boolean(match && match[2][0] === marker && match[2].length >= minimumLength);
}

export function parseStreamingMarkdown(source: string): StreamingMarkdownBlock[] {
  const blocks: StreamingMarkdownBlock[] = [];
  let cursor = 0;
  let markdownStart = 0;
  let codeIndex = 0;

  const pushMarkdown = (start: number, end: number) => {
    if (end <= start) return;
    blocks.push({ type: 'markdown', key: `markdown-${start}`, content: source.slice(start, end) });
  };

  while (cursor < source.length) {
    const line = readLine(source, cursor);
    const opening = openingFence(line);
    if (!opening) {
      cursor = line.next;
      continue;
    }

    pushMarkdown(markdownStart, line.start);
    const codeStart = line.next;
    let codeCursor = codeStart;
    let closing: SourceLine | undefined;

    while (codeCursor < source.length) {
      const candidate = readLine(source, codeCursor);
      if (isClosingFence(candidate, opening.marker, opening.length)) {
        closing = candidate;
        break;
      }
      codeCursor = candidate.next;
    }

    blocks.push({
      type: 'code',
      key: `code-${line.start}`,
      raw: source.slice(codeStart, closing?.start ?? source.length),
      lang: opening.lang,
      closed: Boolean(closing),
      blockIndex: codeIndex,
    });
    codeIndex += 1;

    if (!closing) return blocks;
    cursor = closing.next;
    markdownStart = cursor;
  }

  pushMarkdown(markdownStart, source.length);
  return blocks;
}
