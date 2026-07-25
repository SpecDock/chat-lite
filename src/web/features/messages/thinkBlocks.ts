export type ThinkBlocks = {
  thinking: string;
  answer: string;
  sawThinkTag: boolean;
};

export function splitThinkBlocks(content: string): ThinkBlocks {
  const openTag = '<think>';
  const closeTag = '</think>';
  const thinking: string[] = [];
  const answer: string[] = [];
  let cursor = 0;
  let sawThinkTag = false;

  while (cursor < content.length) {
    const start = content.indexOf(openTag, cursor);
    if (start === -1) {
      answer.push(content.slice(cursor));
      break;
    }
    sawThinkTag = true;
    if (start > cursor) answer.push(content.slice(cursor, start));
    const bodyStart = start + openTag.length;
    const end = content.indexOf(closeTag, bodyStart);
    if (end === -1) {
      thinking.push(content.slice(bodyStart));
      cursor = content.length;
      break;
    }
    thinking.push(content.slice(bodyStart, end));
    cursor = end + closeTag.length;
  }

  return {
    thinking: thinking.map(part => part.trim()).filter(Boolean).join('\n\n'),
    answer: answer.join(''),
    sawThinkTag,
  };
}
