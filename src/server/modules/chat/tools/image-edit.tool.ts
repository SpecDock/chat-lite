import { tool } from 'langchain';
import { z } from 'zod';
import { generateImageForUser } from '../../images/imageGeneration.js';
import { normalizeAttachmentId } from './image-understand.tool.js';
import type { ToolBudget } from './tool-budget.js';

export async function executeImageEditForUser(input: { userId: string; conversationId: string; prompt: string; sourceAttachmentId: string }) {
  return await generateImageForUser({
    userId: input.userId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    sourceAttachmentId: input.sourceAttachmentId
  });
}

export function createImageToImageTool(input: { userId: string; conversationId: string; budget: ToolBudget }) {
  const { userId, conversationId, budget } = input;
  return tool(async ({ attachmentId, prompt }) => {
    const blocked = budget.take('image_to_image');
    if (blocked) return blocked;
    try {
      const result = await executeImageEditForUser({ userId, conversationId, prompt, sourceAttachmentId: normalizeAttachmentId(attachmentId) });
      return `已基于原图真实生成新图片并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
    } catch (error) {
      return `image_to_image 工具暂不可用：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }, {
    name: 'image_to_image',
    description: '图生图工具。用户上传了图片，并要求“根据这张图生成/编辑原图/加元素/加贴纸/加爱心/改成某风格/重绘/变成头像/换背景/参考原图生成”等需要保留原图视觉信息的任务时必须调用。输入源图 attachmentId 和完整编辑要求。工具会真正生成并保存图片，返回 Markdown 图片链接；最终回复必须包含该链接。不要只说将要生成，不要输出工具 JSON，不要用文生图替代。',
    schema: z.object({
      attachmentId: z.string().min(1).describe('作为图生图源图的当前用户图片附件 ID'),
      prompt: z.string().min(1).describe('图生图编辑/生成要求，保留用户指定的风格、主体、比例、文字等细节')
    })
  });
}