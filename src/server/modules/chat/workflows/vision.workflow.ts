import { chooseSourceAttachmentId } from '../image-selection.service.js';
import { streamVisionAnswerForUser, understandImageForUser } from '../tools/image-understand.tool.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamFinalAnswer } from './streaming.js';

export async function* runVisionWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  const attachmentId = input.sourceAttachmentId || chooseSourceAttachmentId(input.input, input.attachmentIds, input.history);
  if (!attachmentId) {
    yield { type: 'delta', text: '请先上传需要识别的图片。' };
    return;
  }
  yield { type: 'think', text: '正在使用主模型识别图片并回答。' };
  try {
    for await (const text of streamVisionAnswerForUser({ userId: input.userId, attachmentId, prompt: input.input || '请描述这张图片', history: input.history, signal: input.signal })) {
      yield { type: 'delta', text };
    }
    return;
  } catch (error) {
    yield { type: 'think', text: `主模型图片识别失败，正在使用 MCP 兜底：${error instanceof Error ? error.message : '未知错误'}` };
  }
  const vision = await understandImageForUser({ userId: input.userId, attachmentId, prompt: input.input || '请描述这张图片' });
  yield { type: 'think', text: '图片识别完成，正在整理回复。' };
  yield* streamFinalAnswer({
    system: '你是图片问答助手。基于图片识别结果回答用户，不要编造图片外信息。用户若上传题目且没有额外约束，直接解答。',
    user: `用户问题：${input.input}\n\n图片识别结果：\n${vision}`,
    signal: input.signal
  });
}
