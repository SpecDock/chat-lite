import { z } from 'zod';
import { executeWebSearch } from '../../../infrastructure/search/web-search.tool.js';
import { normalizeAttachmentId } from '../tools/normalize-attachment-id.js';
import { readFile } from 'node:fs/promises';
import { assertNotAborted, type AgentContext, type ToolDef, type ToolName } from './tool-def.js';
import { row } from '../../../infrastructure/db/db.js';
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
      '查看本轮提供的历史图片候选。用户引用之前上传或生成的图片、需要识别或分析其内容时调用。只能传候选摘要中给出的 attachmentId；成功后下一轮请求会看到图片本体。当前轮上传图片已直接可见，不需要调用此工具。',
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
        text: `已加载历史图片 ${attachmentId}。图片本体已加入上下文，可据此识别或搜索。`
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
      const result = await executeWebSearch({ query: args.query, signal: ctx.signal });
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return `以下是联网搜索结果，请基于这些内容回答用户的问题，不要编造搜索结果之外的事实：\n\n${text}`;
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
