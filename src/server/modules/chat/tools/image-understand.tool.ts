import { readFile } from 'node:fs/promises';
import { tool } from 'langchain';
import { z } from 'zod';
import type { MessageDTO } from '../../../../shared/types.js';
import { row } from '../../../core/db.js';
import { callMiniMaxTool } from '../../images/mcp.js';
import { createChatModel, textFromModelMessage } from '../model.js';
import { answerHistoryLimit } from '../history-limits.js';
import type { ToolBudget } from './tool-budget.js';

function historyContextForVision(history: Pick<MessageDTO, 'role' | 'content'>[] = []) {
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-answerHistoryLimit())
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 700)}`)
    .join('\n');
}

export function normalizeAttachmentId(value: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://chat-lite.local');
    const match = url.pathname.match(/\/api\/files\/([^/?#]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {}
  const match = raw.match(/\/api\/files\/([^/?#\s]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : raw;
}

export function normalizeImageAttachmentId(value: string) {
  return normalizeAttachmentId(value);
}

async function understandImageWithPrimaryModel(att: { file_path: string; mime_type: string }, prompt: string, signal?: AbortSignal) {
  const buffer = await readFile(att.file_path);
  const dataUrl = `data:${att.mime_type};base64,${buffer.toString('base64')}`;
  const message = await createChatModel().invoke(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || '请描述这张图片' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    { signal }
  );
  const text = textFromModelMessage(message).trim();
  if (!text) throw new Error('主模型未返回图片理解结果');
  return text;
}

export async function understandImageForUser(input: { userId: string; attachmentId: string; prompt?: string; signal?: AbortSignal }) {
  const normalizedAttachmentId = normalizeAttachmentId(input.attachmentId);
  const att = row<{ file_path: string; mime_type: string }>(
    'SELECT file_path,mime_type FROM attachments WHERE id=? AND user_id=?', normalizedAttachmentId, input.userId
  );
  if (!att) throw new Error(`找不到当前用户的图片附件：${normalizedAttachmentId || input.attachmentId}`);
  const prompt = input.prompt || '请详细识别这张图片的内容。';
  try {
    return await understandImageWithPrimaryModel(att, prompt, input.signal);
  } catch (primaryError) {
    console.warn('[understand_image] primary vision failed, falling back to MCP:', primaryError instanceof Error ? primaryError.message : primaryError);
  }
  return await callMiniMaxTool('understand_image', { image_source: att.file_path, prompt });
}

export async function* streamVisionAnswerForUser(input: { userId: string; attachmentId: string; prompt: string; history?: Pick<MessageDTO, 'role' | 'content'>[]; signal?: AbortSignal }) {
  const normalizedAttachmentId = normalizeAttachmentId(input.attachmentId);
  const att = row<{ file_path: string; mime_type: string }>(
    'SELECT file_path,mime_type FROM attachments WHERE id=? AND user_id=?', normalizedAttachmentId, input.userId
  );
  if (!att) throw new Error(`找不到当前用户的图片附件：${normalizedAttachmentId || input.attachmentId}`);
  const buffer = await readFile(att.file_path);
  const dataUrl = `data:${att.mime_type};base64,${buffer.toString('base64')}`;
  const stream = await createChatModel().stream([
    {
      role: 'user',
      content: [
        { type: 'text', text: `你是图片问答助手。请结合图片、用户问题和最近上下文直接回答。若图片内容是数学题、语文题、英语题、考试题、作业题、练习题或截图题，且用户没有明确要求“只描述/只识别/不要解答/只给提示”，你需要自动进行解答并给出必要步骤；涉及数学、物理、化学公式时，行内公式使用 $...$，独立公式使用 $$...$$，不要用 [ ... ] 包裹公式；不要编造图片外信息。\n\n最近上下文：\n${historyContextForVision(input.history) || '(无)'}\n\n用户问题：${input.prompt || '请描述这张图片'}` },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ], { signal: input.signal });
  for await (const chunk of stream) {
    const text = textFromModelMessage(chunk);
    if (text) yield text;
  }
}

export function createUnderstandImageTool(input: { userId: string; budget: ToolBudget }) {
  const { userId, budget } = input;
  return tool(async ({ attachmentId, prompt }) => {
    const blocked = budget.take('understand_image');
    if (blocked) return blocked;
    try {
      return await understandImageForUser({ userId, attachmentId, prompt });
    } catch (error) {
      return `understand_image 工具暂不可用：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }, {
    name: 'understand_image',
    description: '图片理解工具。只能分析当前用户上传过的图片附件。用于“这是什么、识别图片、分析截图、解题、先说明图片内容”等任务。优先使用主模型多模态视觉；主模型失败时自动 fallback 到 MCP understand_image。输入 attachmentId 和要询问图片的问题。工具返回的是图片内容，不是最终回答；拿到结果后再按用户要求回答。',
    schema: z.object({
      attachmentId: z.string().min(1).describe('用户上传图片的附件 ID'),
      prompt: z.string().default('请描述这张图片').describe('对图片的分析要求')
    })
  });
}
