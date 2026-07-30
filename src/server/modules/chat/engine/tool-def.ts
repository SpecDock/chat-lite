import type { z } from 'zod';
import type { MessageDTO } from '../../../../shared/types.js';
import { answerHistoryLimit } from '../history-limits.js';
import { selectModelVisibleHistory, stripThinkBlocks } from '../message-visibility.js';

export type ToolName = 'web_search' | 'text_to_image' | 'image_edit' | 'view_image';

export type ImageCandidate = {
  attachmentId: string;
  label: string;
  createdAt: string;
  sourceText: string;
};

export type AgentContext = {
  userId: string;
  conversationId: string;
  requestId?: string;
  userInput: string;
  history: Pick<MessageDTO, 'role' | 'content' | 'status' | 'created_at'>[];
  conversationSummary?: string;
  attachmentIds: string[];
  imageCandidates?: { current: ImageCandidate[]; historical: ImageCandidate[]; generated: ImageCandidate[] };
  viewedImageIds?: Set<string>;
  signal?: AbortSignal;
};

/**
 * Per-run mutable flags threaded through tool calls so individual tools
 * (and the executor that calls them) can share state without each tool
 * having to re-derive it. Mirrors what OpenCode threads via the closure
 * inside `run-state.ts`.
 */
export type AgentRunFlags = {
  imageAlreadyProduced: boolean;
};

export type AgentUsage = {
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheMeasuredPromptTokens?: number;
  cachedTokens?: number;
};

export function aggregateAgentUsage(current: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  const currentHasCache = Number.isFinite(current?.cacheMeasuredPromptTokens) && Number.isFinite(current?.cachedTokens);
  const nextHasCache = Number.isFinite(next.cacheMeasuredPromptTokens) && Number.isFinite(next.cachedTokens);
  const hasCache = currentHasCache || nextHasCache;
  return {
    model: next.model ?? current?.model,
    promptTokens: (current?.promptTokens || 0) + (next.promptTokens || 0),
    completionTokens: (current?.completionTokens || 0) + (next.completionTokens || 0),
    totalTokens: (current?.totalTokens || 0) + (next.totalTokens || 0),
    ...(hasCache ? {
      cacheMeasuredPromptTokens: (currentHasCache ? current?.cacheMeasuredPromptTokens || 0 : 0)
        + (nextHasCache ? next.cacheMeasuredPromptTokens || 0 : 0),
      cachedTokens: (currentHasCache ? current?.cachedTokens || 0 : 0)
        + (nextHasCache ? next.cachedTokens || 0 : 0),
    } : {}),
  };
}

/**
 * Streamed events produced by the agent loop. `think` and `delta` are
 * forwarded to the SSE stream as `think` / `delta` events. `usage` is
 * forwarded as `usage` events for billing. The chat.ts layer emits terminal
 * events (`done` / `cancelled` / `error`).
 */
export type AgentEvent =
  | { type: 'think'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: AgentUsage };

/**
 * A tool returns either:
 * - a plain string (treated as the tool message content and a think hint of
 *   "工具调用完成：<name>")
 * - an AgentEvent (e.g. delta / usage)
 * - an async generator of AgentEvents
 */
export type ToolExecuteResult = AgentEvent | string | AsyncGenerator<AgentEvent | string> | {
  type: 'view_image';
  text: string;
  dataUrl: string;
  attachmentId: string;
} | {
  type: 'tool_error';
  text: string;
};

export type ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: ToolName;
  description: string;
  schema: TSchema;
  execute(args: z.infer<TSchema>, ctx: AgentContext): Promise<ToolExecuteResult> | ToolExecuteResult;
};

export function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
}

export function historyText(history: Pick<MessageDTO, 'role' | 'content' | 'status'>[], limit: number = answerHistoryLimit(), slice = 800) {
  return selectModelVisibleHistory(history, limit)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.role === 'assistant' ? stripThinkBlocks(m.content).slice(0, slice) : String(m.content || '').slice(0, slice)}`)
    .join('\n');
}
