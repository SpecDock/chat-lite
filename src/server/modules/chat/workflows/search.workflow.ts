import { executeWebSearch } from '../tools/web-search.tool.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamFinalAnswer } from './streaming.js';

export async function* runSearchWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  yield { type: 'think', text: '正在搜索网页。' };
  const result = await executeWebSearch({ query: input.input });
  yield { type: 'think', text: '搜索完成，正在整理回复。' };
  yield* streamFinalAnswer({
    system: '你是联网搜索问答助手。必须基于搜索结果回答，不要编造。',
    user: `用户问题：${input.input}\n\n搜索结果：\n${result}`,
    signal: input.signal
  });
}