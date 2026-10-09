export type RagChunk = {
  text: string;
  parentText: string;
  type?: string;
  importance?: number;
};

const CHILD_SIZE = 200;
const CHILD_OVERLAP = 50;
const PARENT_SIZE = 800;
const PARENT_OVERLAP = 100;

const SEPARATORS = ['\n## ', '\n### ', '\n#### ', '\n# ', '\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', '; ', '，', ', ', ' ', ''];

function runeLength(text: string) {
  return [...text].length;
}

function tailRunes(text: string, count: number) {
  const runes = [...text];
  if (runes.length <= count) return text;
  return runes.slice(runes.length - count).join('');
}

function hardSplit(text: string, size: number) {
  const runes = [...text];
  const out: string[] = [];
  for (let index = 0; index < runes.length; index += size) out.push(runes.slice(index, index + size).join(''));
  return out;
}

function splitKeepingSep(text: string, separator: string) {
  const parts = text.split(separator);
  if (parts.length <= 1) return parts;
  return [parts[0], ...parts.slice(1).map(part => separator + part)];
}

function recursiveSplit(text: string, size: number, separators: string[]): string[] {
  if (runeLength(text) <= size) return text.trim() ? [text] : [];
  if (!separators.length || separators[0] === '') return hardSplit(text, size);
  const [separator, ...rest] = separators;
  const out: string[] = [];
  for (const part of splitKeepingSep(text, separator)) {
    if (runeLength(part) <= size) {
      if (part.trim()) out.push(part);
      continue;
    }
    out.push(...recursiveSplit(part, size, rest));
  }
  return out;
}

function mergePieces(pieces: string[], size: number, overlap: number) {
  const merged: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece;
      continue;
    }
    if (runeLength(buffer) + runeLength(piece) <= size) {
      buffer += piece;
      continue;
    }
    merged.push(buffer);
    buffer = piece;
  }
  if (buffer) merged.push(buffer);
  if (overlap <= 0 || merged.length < 2) return merged;
  return merged.map((piece, index) => index === 0 ? piece : tailRunes(merged[index - 1], overlap) + piece);
}

function splitText(text: string, size: number, overlap: number) {
  return mergePieces(recursiveSplit(text, size, SEPARATORS), size, overlap).map(piece => piece.trim()).filter(Boolean);
}

export function cleanForIndexing(text: string, maxChars: number) {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  if (runeLength(cleaned) > maxChars) cleaned = [...cleaned].slice(0, maxChars).join('');
  return cleaned;
}

export function splitIndexedChunks(text: string): RagChunk[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const parents = splitText(cleaned, PARENT_SIZE, PARENT_OVERLAP);
  const chunks: RagChunk[] = [];
  for (const parentText of parents) {
    for (const child of splitText(parentText, CHILD_SIZE, CHILD_OVERLAP)) {
      chunks.push({ text: child, parentText, type: 'text', importance: 0.5 });
    }
  }
  return chunks;
}
