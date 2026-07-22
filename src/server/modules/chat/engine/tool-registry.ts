import { z } from 'zod';
import { executeWebSearch } from '../tools/web-search.tool.js';
import { executeTextImageForUser } from '../tools/text-image.tool.js';
import { executeImageEditForUser } from '../tools/image-edit.tool.js';
import { normalizeAttachmentId } from '../tools/normalize-attachment-id.js';
import { readFile } from 'node:fs/promises';
import { assertNotAborted, type AgentContext, type ToolDef, type ToolName } from './tool-def.js';
import { row } from '../../../core/db.js';

/**
 * Convert a zod schema to OpenAI function-calling parameters JSON.
 *
 * zod v4 ships `schema.toJSONSchema()` natively. We previously relied on
 * `zod-to-json-schema@3.25.2`, but that library doesn't understand zod v4's
 * internal `_def` and produces an empty schema, which causes OpenAI strict
 * function calling to fail and the model to hallucinate tool arguments.
 * See `opencode-agent-architecture.md` for related agent-loop tooling notes.
 */
function zodToOpenAIFunctionParameters(schema: z.ZodType): Record<string, unknown> {
  if (typeof (schema as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    const raw = (schema as unknown as { toJSONSchema: () => Record<string, unknown> }).toJSONSchema();
    const { $schema: _ignored, ...parameters } = raw;
    void _ignored;
    return parameters;
  }
  const raw = (schema as unknown as { _def?: unknown })._def;
  throw new Error('tool schema is not a zod v4 schema with toJSONSchema(); cannot convert to OpenAI function parameters');
}

/**
 * Tool definitions exposed to the main agent loop. Each tool returns a string
 * that gets fed back to the main model as a `tool` role message. The string is
 * also wrapped so the model knows what kind of artifact it received (e.g.
 * search snippets, generated image markdown).
 */
const toolDefs = [
  {
    name: 'view_image',
    description:
      '查看本轮提供的历史图片候选。用户引用之前上传或生成的图片、需要识别/分析其内容，或要编辑历史图片时优先调用。只能传候选摘要中给出的 attachmentId；成功后主模型会在下一工具决策轮真正看到图片本体。当前轮上传图片已直接可见，不需要调用此工具。',
    schema: z.object({ attachmentId: z.string().min(1).describe('历史用户图或生成图候选中的 attachmentId') }),
    async execute(args: { attachmentId: string }, ctx: AgentContext) {
      assertNotAborted(ctx.signal);
      const attachmentId = normalizeAttachmentId(args.attachmentId);
      const candidates = [...(ctx.imageCandidates?.historical || []), ...(ctx.imageCandidates?.generated || [])];
      if (!candidates.some(candidate => candidate.attachmentId === attachmentId)) {
        return { type: 'tool_error', text: '无法查看该图片：请选择本轮历史图片候选中的附件。' };
      }
      const attachment = row<{ file_path: string; mime_type: string }>(
        "SELECT file_path, mime_type FROM attachments WHERE id=? AND user_id=? AND conversation_id=? AND mime_type LIKE 'image/%'",
        attachmentId, ctx.userId, ctx.conversationId
      );
      if (!attachment) return { type: 'tool_error', text: '无法查看该图片：图片不存在、无权访问或不属于当前会话。' };
      let buffer: Buffer;
      try { buffer = await readFile(attachment.file_path); } catch (error) {
        console.warn('[view_image] attachment read failed', { attachmentId, error: error instanceof Error ? error.message : error });
        return { type: 'tool_error', text: '无法读取该图片文件，请重新上传后再试。' };
      }
      ctx.viewedImageIds?.add(attachmentId);
      return {
        type: 'view_image',
        attachmentId,
        dataUrl: `data:${attachment.mime_type || 'image/png'};base64,${buffer.toString('base64')}`,
        text: `已加载历史图片 ${attachmentId}。下一工具决策轮将收到该图片本体，可据此识别、搜索或编辑。`
      };
    }
  },
  {
    name: 'web_search',
    description:
      '联网搜索工具。用于事实核验、证据不足、专业知识、医药咨询、实时信息，或用户明确要求搜索；医药问题可用不同 query 多次查询和比对。不要用于纯写作、翻译或闲聊。',
    schema: z.object({ query: z.string().min(1).describe('搜索查询词；尽量保留用户原话的关键实体，避免额外修饰') }),
    async execute(args: { query: string }, ctx: AgentContext) {
      assertNotAborted(ctx.signal);
      const result = await executeWebSearch({ query: args.query });
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return `以下是联网搜索结果，请基于这些内容回答用户的问题，不要编造搜索结果之外的事实：\n\n${text}`;
    }
  },
  {
    name: 'text_to_image',
    description:
      '高耗时且付费的文生图工具。仅当用户明确要求实际交付无原图的图片成品、且关键要求无歧义时调用。识别、分析、评价、答题、文字建议或构思不调用；歧义时不要调用，改为简短澄清。',
    schema: z.object({ prompt: z.string().min(1).describe('完整的图片生成提示词；保留用户要求的风格、主体、比例、文字等细节') }),
    async execute(args: { prompt: string }, ctx: AgentContext) {
      assertNotAborted(ctx.signal);
      const result = await executeTextImageForUser({ userId: ctx.userId, conversationId: ctx.conversationId, prompt: args.prompt, signal: ctx.signal });
      return `图片已真实生成并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
    }
  },
  {
    name: 'image_edit',
    description:
      '高耗时且付费的图像编辑工具。仅当用户明确要求实际交付基于原图的编辑成品、且关键要求无歧义时调用；识别、分析、评价、答题、文字建议或构思不调用，歧义时简短澄清。attachmentId 可选：不传时使用当前图1；显式传当前候选可选择当前图；显式传历史/生成候选必须先 view_image；不属于候选的 ID 会被拒绝。不要传完整 URL。',
    schema: z.object({
      attachmentId: z.string().min(1).nullish().describe('可选源图附件 ID。传当前候选则使用该图；传历史或生成候选前必须先 view_image；未知 ID 会被拒绝。不传时默认当前图1。'),
      prompt: z.string().min(1).describe('完整的编辑要求：写清楚要改什么、改成什么、保留什么、最终风格。例："保持原图构图与所有元素位置不变，仅把图中所有红色元素替换为深蓝色，自然写实风格，高清"。禁止写"修改图片""改成那样"这种占位文本。')
    }),
    async execute(args: { attachmentId?: string; prompt: string }, ctx: AgentContext) {
      assertNotAborted(ctx.signal);
      // Backend picks the source image. Priority:
      // 1. current-turn uploaded attachmentIds — ALWAYS preferred when present.
      //    The model often hallucinates an attachmentId like "att_0" or "uploaded_image".
      //    We deliberately ignore the model's value in that case because
      //    ctx.attachmentIds is the authoritative source for "what was uploaded just now".
      // 2. caller-provided attachmentId — only honored when user uploaded nothing
      //    this turn AND the user explicitly referenced a historical image
      //    (e.g. "刚才那张/上文那张/图2").
      // 3. otherwise error.
      let sourceAttachmentId = '';
      const normalizedArg = args.attachmentId ? normalizeAttachmentId(args.attachmentId) : '';
      const currentIds = (ctx.imageCandidates?.current || []).map(candidate => candidate.attachmentId);
      if (normalizedArg && currentIds.includes(normalizedArg)) {
        // If the current turn has multiple images and the model chose one of
        // the real current attachment IDs (the user said 图2/第二张 etc), honor
        // it. Otherwise keep the old safe default: current-turn first image.
        sourceAttachmentId = normalizedArg;
      } else if (normalizedArg) {
        const historicalIds = new Set([...(ctx.imageCandidates?.historical || []), ...(ctx.imageCandidates?.generated || [])]
          .map(candidate => candidate.attachmentId));
        if (!historicalIds.has(normalizedArg)) {
          return { type: 'tool_error', text: '无法编辑该图片：attachmentId 不属于本轮图片候选。' };
        }
        if (!ctx.viewedImageIds?.has(normalizedArg)) {
          return { type: 'tool_error', text: '无法编辑该历史图片：请先使用 view_image 查看它。' };
        }
        sourceAttachmentId = normalizedArg;
      } else {
        sourceAttachmentId = currentIds[0] || '';
      }
      if (!sourceAttachmentId) {
        return { type: 'tool_error', text: '无法编辑：请先上传图片，或提供本轮候选中的图片附件。' };
      }
      const result = await executeImageEditForUser({ userId: ctx.userId, conversationId: ctx.conversationId, prompt: args.prompt, sourceAttachmentId, signal: ctx.signal });
      return `已基于原图真实生成新图片并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
    }
  }
] satisfies ToolDef[];

export class ToolRegistry {
  private readonly defs = new Map<ToolName, ToolDef>();
  private readonly openAiTools: ChatOpenAITool[];

  constructor(defs: ToolDef[] = toolDefs) {
    defs.forEach(def => this.defs.set(def.name, def));
    this.openAiTools = defs.map(toOpenAITool);
  }

  get(name: ToolName): ToolDef | undefined {
    return this.defs.get(name);
  }

  list(): ToolDef[] {
    return Array.from(this.defs.values());
  }

  /**
   * Tools formatted for `ChatOpenAI.bindTools()`. Each entry is the
   * OpenAI chat-completions function-calling shape (the same one the Chat
   * Completions / Responses endpoints accept).
   */
  buildOpenAITools(): ChatOpenAITool[] {
    return this.openAiTools;
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

/**
 * OpenAI chat-completions tool shape used by `bindTools` and the Responses
 * API. Mirrors `OpenAI.Chat.ChatCompletionTool`.
 */
export type ChatOpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

function toOpenAITool(def: ToolDef): ChatOpenAITool {
  const parameters = zodToOpenAIFunctionParameters(def.schema);
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters
    }
  };
}
