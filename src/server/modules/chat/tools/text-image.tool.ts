import { tool } from 'langchain';
import { z } from 'zod';
import { generateImageForUser } from '../../images/imageGeneration.js';
import type { ToolBudget } from './tool-budget.js';

export async function executeTextImageForUser(input: { userId: string; conversationId: string; prompt: string; signal?: AbortSignal }) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    signal: input.signal
  });
}

export function createGenerateImageTool(input: { userId: string; conversationId: string; budget: ToolBudget }) {
  const { userId, conversationId, budget } = input;
  return tool(async ({ prompt }) => {
    const blocked = budget.take('generate_image');
    if (blocked) return blocked;
    try {
      const result = await executeTextImageForUser({ userId, conversationId, prompt });
      return `图片已真实生成并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
    } catch (error) {
      return `generate_image 工具暂不可用：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }, {
    name: 'generate_image',
    description: '图片生成工具。用户要求画图、生成图片、文生图、logo、头像、海报、插画等视觉内容时必须调用。返回可直接展示的 Markdown 图片链接。',
    schema: z.object({ prompt: z.string().min(1).describe('完整的图片生成提示词，保留用户要求的风格、主体、比例、文字等细节') })
  });
}