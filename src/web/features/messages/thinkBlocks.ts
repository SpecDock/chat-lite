import { decodeExecutionBlock, type ExecutionBlock } from '../../../shared/execution-block';

export type ThinkBlocks = {
  thinking: string;
  execution: ExecutionBlock | null;
  answer: string;
  sawThinkTag: boolean;
  sawExecutionBlock: boolean;
};

export function splitThinkBlocks(content: string): ThinkBlocks {
  const executionTag = /<chat-lite-execution v="1">[\s\S]*?<\/chat-lite-execution>/g;
  let sawExecutionBlock = false;
  let execution: ExecutionBlock | null = null;
  const withoutExecution = String(content || '').replace(executionTag, tag => {
    sawExecutionBlock = true;
    const decoded = decodeExecutionBlock(tag);
    if (decoded) execution = decoded;
    return '';
  }).replace(/<chat-lite-execution v="1">[\s\S]*$/, () => {
    sawExecutionBlock = true;
    return '';
  });
  const openTag = '<think>';
  const closeTag = '</think>';
  const thinking: string[] = [];
  const answer: string[] = [];
  let cursor = 0;
  let sawThinkTag = false;

  while (cursor < withoutExecution.length) {
    const start = withoutExecution.indexOf(openTag, cursor);
    if (start === -1) {
      answer.push(withoutExecution.slice(cursor));
      break;
    }
    sawThinkTag = true;
    if (start > cursor) answer.push(withoutExecution.slice(cursor, start));
    const bodyStart = start + openTag.length;
    const end = withoutExecution.indexOf(closeTag, bodyStart);
    if (end === -1) {
      thinking.push(withoutExecution.slice(bodyStart));
      cursor = withoutExecution.length;
      break;
    }
    thinking.push(content.slice(bodyStart, end));
    cursor = end + closeTag.length;
  }

  return {
    thinking: thinking.map(part => part.trim()).filter(Boolean).join('\n\n'),
    execution,
    answer: answer.join(''),
    sawThinkTag,
    sawExecutionBlock,
  };
}
