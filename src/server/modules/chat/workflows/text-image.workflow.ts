import { executeTextImageForUser } from '../tools/text-image.tool.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamLiteralText } from './streaming.js';

export async function* runTextImageWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  yield { type: 'think', text: '正在生成图片。' };
  const result = await executeTextImageForUser({ userId: input.userId, conversationId: input.conversationId, prompt: input.input });
  if (!result.markdown.includes('/api/files/att_')) throw new Error('文生图未返回有效图片附件');
  yield* streamLiteralText(`已生成图片：\n\n${result.markdown}`);
}