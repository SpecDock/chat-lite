import type { MessageDTO, MessageStatus } from '../../../shared/types.js';
import { stripExecutionBlocks } from '../../../shared/execution-block.js';

export type MessageVisibilityInput = Pick<MessageDTO, 'role' | 'content'> & { status?: MessageStatus };

const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\([^\s)]+\)/;
const FAILED_ASSISTANT_PLACEHOLDERS = new Set([
  '当前主模型额度不足或认证失败，请更换可用的模型 API Key 后再试。',
  '当前主模型连接被中断（上游服务不稳定或请求超时）。已自动尝试 2 次仍失败，请稍后重试。',
  '当前主模型调用失败，请稍后重试。',
  '主模型未返回正文，请尝试重新提问或调整描述。'
]);

export function stripThinkBlocks(text: string): string {
  return stripExecutionBlocks(String(text || '').replace(/<think>[\s\S]*?<\/think>/g, ''));
}

export function isKnownFailedAssistantPlaceholder(content: string): boolean {
  return FAILED_ASSISTANT_PLACEHOLDERS.has(stripThinkBlocks(content));
}

export function isModelVisibleMessage(message: MessageVisibilityInput): boolean {
  if (message.role === 'user') return true;
  if (message.role !== 'assistant' || message.status === 'error' || message.status === 'streaming') return false;
  const visible = stripThinkBlocks(message.content);
  if (!visible || isKnownFailedAssistantPlaceholder(message.content)) return false;
  if (message.status === 'interrupted' && visible === '已取消') return false;
  return visible.length > 0 || IMAGE_MARKDOWN_RE.test(message.content);
}

export function selectModelVisibleHistory<T extends MessageVisibilityInput>(history: T[], limit: number): T[] {
  return history.filter(isModelVisibleMessage).slice(-limit);
}
