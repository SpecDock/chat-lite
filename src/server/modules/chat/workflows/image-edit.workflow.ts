import { chooseSourceAttachmentId } from '../image-selection.service.js';
import { executeImageEditForUser } from '../tools/image-edit.tool.js';
import { understandImageForUser } from '../tools/image-understand.tool.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamFinalAnswer, streamLiteralText } from './streaming.js';

function wantsDescription(input: string) {
  return /先.*(说|描述|识别|分析)|这是什么|图片.*什么|先看/.test(input);
}

export async function* runImageEditWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  const attachmentId = input.sourceAttachmentId || chooseSourceAttachmentId(input.input, input.attachmentIds, input.history);
  if (!attachmentId) {
    yield { type: 'delta', text: '请先上传需要编辑的原图。' };
    return;
  }
  let description = '';
  if (wantsDescription(input.input)) {
    yield { type: 'think', text: '正在识别原图内容。' };
    description = await understandImageForUser({ userId: input.userId, attachmentId, prompt: input.input });
  }
  yield { type: 'think', text: '正在生成图片。' };
  const result = await executeImageEditForUser({ userId: input.userId, conversationId: input.conversationId, prompt: input.input, sourceAttachmentId: attachmentId });
  if (!result.markdown.includes('/api/files/att_')) throw new Error('图生图未返回有效图片附件');
  if (!description) {
    yield* streamLiteralText(`已完成图生图编辑：\n\n${result.markdown}`);
    return;
  }
  yield { type: 'think', text: '正在整理最终回复。' };
  yield* streamFinalAnswer({
    system: '你是图片编辑结果助手。简短说明图片内容和编辑结果，必须原样包含给定 Markdown 图片链接。',
    user: `用户要求：${input.input}\n\n图片识别结果：${description}\n\n生成图片链接：${result.markdown}\n\n最终回复必须包含这段 Markdown：${result.markdown}`,
    signal: input.signal
  });
}
