import { executeTextImageForUser } from '../tools/text-image.tool.js';
import { generateImageBatchForUser } from '../../images/image-generation.service.js';
import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamLiteralText } from './streaming.js';
import { refineTextImagePrompt, refineTextImagePrompts } from './prompt-refine.js';

function previewPrompt(prompt: string) {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function markdownUrl(markdown: string): string | null {
  const match = markdown.match(/\]\(([^)]+)\)/);
  return match?.[1] || null;
}

export async function* runTextImageWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  const prompts = (input.prompts || [])
    .map(p => String(p == null ? '' : p).trim())
    .filter(p => p.length > 0);

  // Backward-compatible single-image path: prompts missing, empty, or length === 1
  // keeps the original behavior unchanged.
  if (prompts.length <= 1) {
    yield { type: 'think', text: '正在优化生成 prompt。' };
    const refinedPrompt = await refineTextImagePrompt({ userRequest: input.input, history: input.history, signal: input.signal });
    yield { type: 'think', text: '正在生成图片。' };
    const result = await executeTextImageForUser({ userId: input.userId, conversationId: input.conversationId, prompt: refinedPrompt, signal: input.signal });
    if (!result.markdown.includes('/api/files/att_')) throw new Error('文生图未返回有效图片附件');
    yield* streamLiteralText(`已生成图片：\n\n${result.markdown}`);
    return;
  }

  const n = prompts.length;
  yield { type: 'think', text: '正在优化生成 prompt。' };
  const refinedPrompts = await refineTextImagePrompts({ userRequest: input.input, history: input.history, count: n, signal: input.signal });
  yield { type: 'think', text: `正在生成 ${n} 张图片。` };
  // Emit intro line immediately so the UI doesn't look stuck while generation runs.
  yield { type: 'delta', text: `以下为你生成 ${n} 张图：\n\n` };

  const results = await generateImageBatchForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompts: refinedPrompts,
    signal: input.signal
  });

  let anyValid = false;
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const idx = i + 1;
    if (item.ok) {
      const url = markdownUrl(item.markdown);
      if (!url) {
        yield* streamLiteralText(`图 ${idx} 生成失败：返回内容不含图片链接\n\n`);
        continue;
      }
      anyValid = true;
      const preview = previewPrompt(item.prompt);
      yield* streamLiteralText(`${idx}. ${preview}\n![图 ${idx}](${url})\n\n`);
    } else {
      yield* streamLiteralText(`图 ${idx} 生成失败：${item.error}\n\n`);
    }
  }

  if (!anyValid) throw new Error('文生图批量生成全部失败');
}