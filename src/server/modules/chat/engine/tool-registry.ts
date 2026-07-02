import { z } from 'zod';
import { executeWebSearch } from '../tools/web-search.tool.js';
import { understandImageForUser } from '../tools/image-understand.tool.js';
import { executeTextImageForUser } from '../tools/text-image.tool.js';
import { executeImageEditForUser } from '../tools/image-edit.tool.js';
import { streamAgentChat } from '../agent.js';
import { streamFinalAnswer, streamLiteralText } from '../workflows/streaming.js';
import { refineImageEditPrompt, refineTextImagePrompt, refineTextImagePrompts } from '../workflows/prompt-refine.js';
import { answerHistoryLimit } from '../history-limits.js';
import { ensureRagInitialized, getRagContext } from '../../rag/rag.js';
import { ragConfig, ragReadActive } from '../../rag/rag.config.js';
import { generateImageBatchForUser } from '../../images/image-generation.service.js';
import type { ToolContext, ToolDef, ToolName, ToolResult } from './tool-def.js';
import { assertNotAborted, historyText, toolError } from './tool-def.js';

type ToolBudgetState = { maxTotal: number; usedTotal: number; perTool: Map<ToolName, number> };

function markdownUrl(markdown: string): string | null {
  const match = markdown.match(/\]\(([^)]+)\)/);
  return match?.[1] || null;
}

function previewPrompt(prompt: string) {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

async function ragBlock(ctx: ToolContext) {
  ensureRagInitialized();
  const cfg = ragConfig();
  if (!ragReadActive() || cfg.topK <= 0) return '';
  return await getRagContext(ctx.userId, ctx.input, ctx.history.length, cfg.topK, ctx.conversationId);
}

async function* streamLlmResponse(args: { mode?: string }, ctx: ToolContext): AsyncGenerator<ToolResult> {
  const searchResults = ctx.artifacts.get<string>('searchResults');
  const imageDescription = ctx.artifacts.get<string>('imageDescription');
  const editedImages = ctx.artifacts.get<string[]>('editedImages');
  const rag = await ragBlock(ctx);
  let system = '你是 Chat Lite 的普通对话助手。使用中文优先回答，保持简洁、准确。不要声称自己已经或将要调用工具；如果问题需要实时信息、图片识别、图片生成、图片编辑等外部能力，而当前没有对应结果，请说明需要使用对应功能。';
  let user = `${rag ? `${rag}\n\n` : ''}最近对话：\n${historyText(ctx.history, answerHistoryLimit()) || '(无)'}\n\n当前用户：${ctx.input}`;
  if (editedImages?.length) {
    const markdown = editedImages.join('\n\n');
    system = '你是图片编辑结果助手。简短说明图片内容和编辑结果，必须原样包含给定 Markdown 图片链接。';
    user = `用户要求：${ctx.input}\n\n图片识别结果：${imageDescription || '(未要求或未取得识别结果)'}\n\n生成图片链接：${markdown}\n\n最终回复必须包含这段 Markdown：${markdown}`;
  } else if (searchResults) {
    system = '你是联网搜索问答助手。必须基于搜索结果回答，不要编造。';
    user = `${rag ? `${rag}\n\n` : ''}用户问题：${ctx.input}\n\n搜索结果：\n${searchResults}`;
  } else if (imageDescription || args.mode === 'vision') {
    system = '你是图片问答助手。基于图片识别结果回答用户，不要编造图片外信息。用户若上传题目且没有额外约束，直接解答。';
    user = `用户问题：${ctx.input}\n\n图片识别结果：\n${imageDescription || '(未取得图片识别结果)'}`;
  }
  for await (const event of streamFinalAnswer({ system, user, signal: ctx.signal })) {
    yield event;
  }
}

const toolDefs = [
  {
    name: 'web_search',
    description: '联网搜索并保存搜索结果。',
    schema: z.object({ query: z.string().min(1).optional() }),
    async execute(args: { query?: string }, ctx) {
      assertNotAborted(ctx.signal);
      const result = await executeWebSearch({ query: args.query || ctx.input });
      return { type: 'result', status: 'success', output: result, artifacts: { searchResults: result }, think: '搜索完成，正在整理回复。' };
    }
  },
  {
    name: 'vision_understand',
    description: '理解图片并保存描述。',
    schema: z.object({ attachmentId: z.string().min(1).optional(), prompt: z.string().optional() }),
    async execute(args: { attachmentId?: string; prompt?: string }, ctx) {
      assertNotAborted(ctx.signal);
      const attachmentId = args.attachmentId || ctx.sourceAttachmentId || ctx.route.sourceAttachmentId;
      if (!attachmentId) return { type: 'result', status: 'error', error: '请先上传需要识别的图片。', recoverable: true };
      const result = await understandImageForUser({ userId: ctx.userId, attachmentId, prompt: args.prompt || ctx.input || '请描述这张图片', signal: ctx.signal });
      return { type: 'result', status: 'success', output: result, artifacts: { imageDescription: result, sourceAttachmentId: attachmentId }, think: '图片识别完成。' };
    }
  },
  {
    name: 'llm_respond',
    description: '基于用户输入、RAG 和上游工具产物流式生成最终文本。',
    schema: z.object({ mode: z.string().optional() }),
    execute: streamLlmResponse
  },
  {
    name: 'prompt_refine_text',
    description: '优化单张文生图 prompt。',
    schema: z.object({}),
    async execute(_args, ctx) {
      const refined = await refineTextImagePrompt({ userRequest: ctx.input, history: ctx.history, signal: ctx.signal });
      return { type: 'result', status: 'success', output: refined, artifacts: { refinedPrompt: refined }, think: '生成 prompt 优化完成。' };
    }
  },
  {
    name: 'prompt_refine_text_batch',
    description: '优化批量文生图 prompts。',
    schema: z.object({ count: z.number().int().min(1).max(6).optional() }),
    async execute(args: { count?: number }, ctx) {
      const count = args.count || Math.max(2, Math.min(ctx.prompts?.length || 2, 6));
      const refined = await refineTextImagePrompts({ userRequest: ctx.input, history: ctx.history, count, signal: ctx.signal });
      return { type: 'result', status: 'success', output: refined, artifacts: { refinedPrompts: refined }, think: '批量生成 prompt 优化完成。' };
    }
  },
  {
    name: 'prompt_refine_edit',
    description: '优化图生图编辑 prompt。',
    schema: z.object({}),
    async execute(_args, ctx) {
      const refined = await refineImageEditPrompt({ userRequest: ctx.input, history: ctx.history, sourceDescription: ctx.artifacts.get<string>('imageDescription') || '', signal: ctx.signal });
      return { type: 'result', status: 'success', output: refined, artifacts: { refinedPrompt: refined }, think: '编辑 prompt 优化完成。' };
    }
  },
  {
    name: 'text_to_image',
    description: '执行文生图，支持单张或批量。',
    schema: z.object({ batch: z.boolean().default(false) }),
    async execute(args: { batch?: boolean }, ctx) {
      assertNotAborted(ctx.signal);
      if (!args.batch) {
        const prompt = ctx.artifacts.get<string>('refinedPrompt') || ctx.input;
        const result = await executeTextImageForUser({ userId: ctx.userId, conversationId: ctx.conversationId, prompt, signal: ctx.signal });
        if (!result.markdown.includes('/api/files/att_')) throw new Error('文生图未返回有效图片附件');
        const finalText = `已生成图片：\n\n${result.markdown}`;
        return { type: 'result', status: 'success', output: result.markdown, artifacts: { generatedImages: [result.markdown], finalText }, think: '图片生成完成。' };
      }
      const prompts = ctx.artifacts.get<string[]>('refinedPrompts') || ctx.prompts || [ctx.input];
      const results = await generateImageBatchForUser({ userId: ctx.userId, conversationId: ctx.conversationId, prompts, signal: ctx.signal });
      let anyValid = false;
      let finalText = `以下为你生成 ${results.length} 张图：\n\n`;
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        const idx = i + 1;
        if (item.ok) {
          const url = markdownUrl(item.markdown);
          if (!url) {
            finalText += `图 ${idx} 生成失败：返回内容不含图片链接\n\n`;
            continue;
          }
          anyValid = true;
          finalText += `${idx}. ${previewPrompt(item.prompt)}\n![图 ${idx}](${url})\n\n`;
        } else {
          finalText += `图 ${idx} 生成失败：${item.error}\n\n`;
        }
      }
      if (!anyValid) throw new Error('文生图批量生成全部失败');
      return { type: 'result', status: 'success', output: results, artifacts: { generatedImages: results, finalText }, think: '批量图片生成完成。' };
    }
  },
  {
    name: 'image_edit',
    description: '执行图生图编辑。',
    schema: z.object({ attachmentId: z.string().min(1).optional() }),
    async execute(args: { attachmentId?: string }, ctx) {
      assertNotAborted(ctx.signal);
      const attachmentId = args.attachmentId || ctx.artifacts.get<string>('sourceAttachmentId') || ctx.sourceAttachmentId || ctx.route.sourceAttachmentId;
      if (!attachmentId) return { type: 'result', status: 'error', error: '请先上传需要编辑的原图。', recoverable: true };
      const prompt = ctx.artifacts.get<string>('refinedPrompt') || ctx.input;
      const result = await executeImageEditForUser({ userId: ctx.userId, conversationId: ctx.conversationId, prompt, sourceAttachmentId: attachmentId, signal: ctx.signal });
      if (!result.markdown.includes('/api/files/att_')) throw new Error('图生图未返回有效图片附件');
      const imageDescription = ctx.artifacts.get<string>('imageDescription');
      const finalText = imageDescription
        ? `图片识别结果：${imageDescription}\n\n已完成图生图编辑：\n\n${result.markdown}`
        : `已完成图生图编辑：\n\n${result.markdown}`;
      return { type: 'result', status: 'success', output: result.markdown, artifacts: { editedImages: [result.markdown], finalText }, think: '图片编辑完成。' };
    }
  },
  {
    name: 'literal_response',
    description: '把保存的文本或图片 Markdown 直接流式输出。',
    schema: z.object({ artifact: z.string().default('finalText') }),
    async *execute(args: { artifact: string }, ctx) {
      const text = ctx.artifacts.get<string>(args.artifact) || String(ctx.artifacts.get('finalText') || '');
      if (!text.trim()) {
        yield { type: 'result', status: 'error', error: '没有可输出的工具结果', recoverable: false };
        return;
      }
      for await (const event of streamLiteralText(text)) yield event;
      yield { type: 'result', status: 'success', output: text };
    }
  },
  {
    name: 'agent_fallback',
    description: '旧 mixed agent 兜底。',
    schema: z.object({}),
    async *execute(_args, ctx) {
      for await (const event of streamAgentChat(ctx)) yield event;
      yield { type: 'result', status: 'success' };
    }
  }
] satisfies ToolDef[];

export class ToolRegistry {
  private readonly defs = new Map<ToolName, ToolDef>();
  private readonly budget: ToolBudgetState;

  constructor(defs: ToolDef[] = toolDefs, maxTotal = 6) {
    defs.forEach(def => this.defs.set(def.name, def));
    this.budget = { maxTotal, usedTotal: 0, perTool: new Map() };
  }

  async *execute(name: ToolName, args: unknown, ctx: ToolContext): AsyncGenerator<ToolResult> {
    const def = this.defs.get(name);
    if (!def) {
      yield { type: 'result', status: 'error', error: `未注册工具：${name}` };
      return;
    }
    const parsed = def.schema.safeParse(args || {});
    if (!parsed.success) {
      yield { type: 'result', status: 'error', error: `工具参数无效：${parsed.error.issues.map(i => i.message).join('；')}` };
      return;
    }
    if (this.budget.usedTotal >= this.budget.maxTotal) {
      yield { type: 'result', status: 'error', error: `工具调用超过预算 ${this.budget.maxTotal}` };
      return;
    }
    this.budget.usedTotal += 1;
    this.budget.perTool.set(name, (this.budget.perTool.get(name) || 0) + 1);
    try {
      const result = await def.execute(parsed.data, ctx);
      if (result && typeof (result as AsyncGenerator<ToolResult>)[Symbol.asyncIterator] === 'function') {
        for await (const item of result as AsyncGenerator<ToolResult>) yield item;
      } else {
        yield result as ToolResult;
      }
    } catch (error) {
      yield toolError(error);
    }
  }
}

export function createDefaultToolRegistry() {
  return new ToolRegistry();
}
