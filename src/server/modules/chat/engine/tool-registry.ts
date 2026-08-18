import { z } from 'zod';
import { executeWebSearch } from '../tools/web-search.tool.js';
import { executeTextImageForUser } from '../tools/text-image.tool.js';
import { executeImageEditForUser } from '../tools/image-edit.tool.js';
import { normalizeAttachmentId } from '../tools/normalize-attachment-id.js';
import { readFile } from 'node:fs/promises';
import { assertNotAborted, type AgentContext, type ImageCandidate, type ToolDef, type ToolName } from './tool-def.js';
import { row } from '../../../core/db.js';
import { executeTableAnalysis } from '../../table-analysis/table-analysis.service.js';

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

const CHINESE_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function candidateAliases(candidate: ImageCandidate): Set<string> {
  const aliases = new Set([candidate.attachmentId, candidate.label]);
  const match = candidate.label.match(/^(当前图|用户历史图|生成图)(\d+)$/);
  if (!match) return aliases;
  const group = match[1];
  const index = Number(match[2]);
  const chinese = CHINESE_NUMBERS[index - 1];
  if (group === '当前图') {
    aliases.add(`图${index}`);
    aliases.add(`图片${index}`);
    aliases.add(`图像${index}`);
    aliases.add(`第${index}张`);
    aliases.add(`第${index}张图`);
    aliases.add(`第${index}张图片`);
    if (chinese) {
      aliases.add(`${chinese}张`);
      aliases.add(`${chinese}张图`);
      aliases.add(`${chinese}张图片`);
      aliases.add(`第${chinese}张`);
      aliases.add(`第${chinese}张图`);
      aliases.add(`第${chinese}张图片`);
    }
  } else if (group === '用户历史图') {
    aliases.add(`历史图${index}`);
    aliases.add(`用户图${index}`);
  } else {
    aliases.add(`历史生成图${index}`);
    aliases.add(`AI生成图${index}`);
  }
  return aliases;
}

function resolveCandidate(value: string | null | undefined, candidates: ImageCandidate[]): ImageCandidate | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const normalized = normalizeAttachmentId(raw);
  return candidates.find(candidate => candidate.attachmentId === normalized || candidateAliases(candidate).has(raw));
}

function candidateListText(candidates: ImageCandidate[]) {
  return candidates.map(candidate => `${candidate.label}=${candidate.attachmentId}`).join('，') || '无';
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
      '高耗时且付费的图像编辑工具。仅当用户明确要求实际交付基于原图的编辑成品、且关键要求无歧义时调用。attachmentId 是主画布；referenceAttachmentIds 是最多3张参考图。多图时后端按主图、参考图1、参考图2、参考图3的顺序发送为 API Image 1..4。用户说“图1放到图2右下角”时，主图必须选图2，参考图必须包含图1。历史/生成图必须先 view_image；未知候选会被拒绝。不要传完整 URL。',
    schema: z.object({
      attachmentId: z.string().min(1).nullish().describe('可选主图附件 ID 或候选标签。不传时默认当前图1；历史或生成候选必须先 view_image。'),
      referenceAttachmentIds: z.array(z.string().min(1)).max(3).nullish().describe('可选参考图附件 ID/候选标签数组，最多3张。不要包含主图；历史或生成候选必须先逐张 view_image。'),
      prompt: z.string().min(1).describe('完整编辑要求。多图时按 API 输入顺序描述：Image 1 是主图，Image 2..4 是参考图；写清从哪张图取什么、放到哪里、缩放比例及主图哪些内容必须保持不变。')
    }),
    async execute(args: { attachmentId?: string | null; referenceAttachmentIds?: string[] | null; prompt: string }, ctx: AgentContext) {
      assertNotAborted(ctx.signal);
      const current = ctx.imageCandidates?.current || [];
      const historical = ctx.imageCandidates?.historical || [];
      const generated = ctx.imageCandidates?.generated || [];
      const allCandidates = [...current, ...historical, ...generated];
      const historicalIds = new Set([...historical, ...generated].map(candidate => candidate.attachmentId));
      const source = args.attachmentId ? resolveCandidate(args.attachmentId, allCandidates) : current[0];
      if (!source && args.attachmentId) {
        return { type: 'tool_error', text: `无法编辑主图：attachmentId 不属于本轮图片候选。可用候选：${candidateListText(allCandidates)}。请使用准确 ID 或候选标签重试。` };
      }
      if (!source) {
        return { type: 'tool_error', text: '无法编辑：请先上传图片，或提供本轮候选中的图片附件。' };
      }
      if (historicalIds.has(source.attachmentId) && !ctx.viewedImageIds?.has(source.attachmentId)) {
        return { type: 'tool_error', text: `无法编辑历史主图 ${source.label}：请先使用 view_image 查看它。` };
      }

      const referenceAttachmentIds: string[] = [];
      for (const rawReference of args.referenceAttachmentIds || []) {
        const candidate = resolveCandidate(rawReference, allCandidates);
        if (!candidate) {
          return { type: 'tool_error', text: `无法使用参考图 ${rawReference}：它不属于本轮图片候选。可用候选：${candidateListText(allCandidates)}。` };
        }
        if (candidate.attachmentId === source.attachmentId || referenceAttachmentIds.includes(candidate.attachmentId)) continue;
        if (historicalIds.has(candidate.attachmentId) && !ctx.viewedImageIds?.has(candidate.attachmentId)) {
          return { type: 'tool_error', text: `无法使用历史参考图 ${candidate.label}：请先使用 view_image 查看它。` };
        }
        referenceAttachmentIds.push(candidate.attachmentId);
      }

      const providerPrompt = referenceAttachmentIds.length
        ? `Input order: Image 1 is the primary canvas. Images 2-${referenceAttachmentIds.length + 1} are reference images. Preserve Image 1 except for the requested edit.\n\n${args.prompt}`
        : args.prompt;
      const result = await executeImageEditForUser({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        prompt: providerPrompt,
        sourceAttachmentId: source.attachmentId,
        referenceAttachmentIds,
        signal: ctx.signal
      });
      const referenceNote = referenceAttachmentIds.length ? `和 ${referenceAttachmentIds.length} 张参考图` : '';
      return `已基于主图${referenceNote}真实生成新图片并保存为附件。请在最终回复中原样包含这个 Markdown 图片链接，不要只说已生成：\n${result.markdown}`;
    }
  },
  {
    name: 'analyze_table',
    description: '分析当前会话中用户上传的 CSV/XLSX 表格。用户要求统计、筛选、清洗、比较、计算或解释表格数据时调用；必须传入真实候选中的 attachmentId 和完整分析要求。工具内部会生成并执行 Python，只有最终成功代码和输出会展示给用户。',
    schema: z.object({
      attachmentId: z.string().min(1).describe('当前会话 CSV/XLSX 附件 ID'),
      instruction: z.string().min(1).describe('完整的表格分析目标、筛选条件、输出要求'),
    }),
    execute(args: { attachmentId: string; instruction: string }, ctx: AgentContext) {
      return executeTableAnalysis(args, ctx);
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
