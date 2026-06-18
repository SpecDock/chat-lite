import type { WorkflowEvent, WorkflowInput } from './types.js';
import { streamFinalAnswer } from './streaming.js';

function historyText(history: WorkflowInput['history']) {
  return history
    .slice(-80)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 800)}`)
    .join('\n');
}

export function runChatWorkflow(input: WorkflowInput): AsyncGenerator<WorkflowEvent> {
  return streamFinalAnswer({
    system: '你是 Chat Lite 的普通对话助手。使用中文优先回答，保持简洁、准确。不要声称会调用工具；如果问题需要实时信息、图片、生成图片等外部能力，说明需要使用对应功能。',
    user: `最近对话：\n${historyText(input.history) || '(无)'}\n\n当前用户：${input.input}`,
    signal: input.signal
  });
}
