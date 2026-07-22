import { z } from 'zod';
import { generateImageForUser } from '../../images/imageGeneration.js';
import type { ToolBudget } from './tool-budget.js';

/**
 * Execute a single text-to-image generation. Used directly by the `text_to_image`
 * ToolDef in the new main agent-loop path.
 */
export async function executeTextImageForUser(input: { userId: string; conversationId: string; prompt: string; signal?: AbortSignal }) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    signal: input.signal
  });
}

/**
 * Legacy LangChain tool wrapper kept for callers that still wire this through
 * `langchain.createAgent`. The new main path uses the `text_to_image` ToolDef
 * in `engine/tool-registry.ts` instead.
 */
export function createGenerateImageTool(input: { userId: string; conversationId: string; budget: ToolBudget }) {
  const { userId, conversationId, budget } = input;
  return {
    name: 'generate_image',
    description: '图片生成工具。用户要求画图、生成图片、文生图、logo、头像、海报、插画等视觉内容时必须调用。返回可直接展示的 Markdown 图片链接。',
    schema: z.object({ prompt: z.string().min(1).describe('完整的图片生成提示词，保留用户要求的风格、主体、比例、文字等细节') }),
    invoke: async (args: { prompt: string }) => {
      const blocked = budget.take('generate_image');
      if (blocked) return blocked;
      try {
        const result = await executeTextImageForUser({ userId, conversationId, prompt: args.prompt });
        return `图片已真实生成并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
      } catch (error) {
        return `generate_image 工具暂不可用：${error instanceof Error ? error.message : '未知错误'}`;
      }
    }
  };
}