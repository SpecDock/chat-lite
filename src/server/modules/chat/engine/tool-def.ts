import type { z } from 'zod';
import type { MessageDTO } from '../../../../shared/types.js';
import type { TaskRoute } from '../task-router.js';
import type { WorkflowEvent, WorkflowInput } from '../workflows/types.js';
import type { ArtifactStore } from './artifact-store.js';

export type ToolName =
  | 'web_search'
  | 'vision_understand'
  | 'llm_respond'
  | 'prompt_refine_text'
  | 'prompt_refine_text_batch'
  | 'prompt_refine_edit'
  | 'text_to_image'
  | 'image_edit'
  | 'literal_response'
  | 'agent_fallback';

export type ToolContext = WorkflowInput & {
  route: TaskRoute;
  artifacts: ArtifactStore;
};

export type ToolResult =
  | { type: 'think'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Extract<WorkflowEvent, { type: 'usage' }>['usage'] }
  | { type: 'result'; status: 'success'; output?: unknown; artifacts?: Record<string, unknown>; think?: string }
  | { type: 'result'; status: 'error'; error: string; recoverable?: boolean; think?: string };

export type ToolExecuteResult = ToolResult | AsyncGenerator<ToolResult>;

export type ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: ToolName;
  description: string;
  schema: TSchema;
  execute(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolExecuteResult> | ToolExecuteResult;
};

export function toolError(error: unknown, recoverable = false): ToolResult {
  return {
    type: 'result',
    status: 'error',
    error: error instanceof Error ? error.message : String(error || '未知错误'),
    recoverable
  };
}

export function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
}

export function historyText(history: Pick<MessageDTO, 'role' | 'content'>[], limit: number, slice = 800) {
  return history
    .slice(-limit)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, slice)}`)
    .join('\n');
}
