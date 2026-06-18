import type { MessageDTO } from '../../../shared/types.js';

export function markdownImageIds(content: string) {
  const ids: string[] = [];
  const re = /\/api\/files\/(att_[A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) ids.push(match[1]);
  return ids;
}

export function imageCandidates(attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[] = []) {
  const ids: string[] = [];
  for (const id of attachmentIds) if (id && !ids.includes(id)) ids.push(id);
  for (const message of [...history].reverse()) {
    for (const id of markdownImageIds(String(message.content || '')).reverse()) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function cnNumber(value: string) {
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^\d+$/.test(value)) return Number(value);
  return map[value] || undefined;
}

export function chooseSourceAttachmentId(input: string, attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[] = []) {
  const candidates = imageCandidates(attachmentIds, history);
  if (!candidates.length) return undefined;
  const numbered = input.match(/(?:图|图片|第)\s*([一二两三四五六七八九十\d]+)\s*(?:张|个)?/);
  const index = numbered?.[1] ? cnNumber(numbered[1]) : undefined;
  if (index && candidates[index - 1]) return candidates[index - 1];
  if (/(上文|之前|刚才|上一张|那张|那个图|历史|原来的)/.test(input)) {
    const historical = candidates.find(id => !attachmentIds.includes(id));
    if (historical) return historical;
  }
  return candidates[0];
}
