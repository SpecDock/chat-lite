import type { BaseMessage } from '@langchain/core/messages';
import { isModelVisibleMessage, stripThinkBlocks } from '../../domain/chat/message-visibility.js';
import { listConversationMessagesAfterCursor } from '../../infrastructure/chat/conversation-context.repo.js';
import type {
  ModelContextContentBlock,
  ModelContextMessage,
  ModelContextToolCall,
} from './conversation-context-snapshot.format.js';

export function snapshotMatchesSystemPrompt(messages: readonly ModelContextMessage[], systemPrompt: string) {
  const first = messages[0];
  return Boolean(first && first.role === 'system' && typeof first.content === 'string' && first.content === systemPrompt);
}

export function supplementalModelMessages(input: {
  conversationId: string;
  userId: string;
  cursorTime: string;
  cursorId: string;
  excludeMessageId?: string;
}): ModelContextMessage[] {
  return listConversationMessagesAfterCursor(input)
    .filter(isModelVisibleMessage)
    .flatMap((message): ModelContextMessage[] => {
      if (message.role === 'user') return [{ role: 'human', content: String(message.content || '') }];
      if (message.role === 'assistant') return [{ role: 'ai', content: stripThinkBlocks(message.content) }];
      return [];
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textContent(content: unknown, index: number) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error(`model context message ${index} content must be a string`);
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    throw new Error(`model context message ${index} content must be a string`);
  }
  return text;
}

function humanContent(content: unknown, index: number): string | ModelContextContentBlock[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`model context message ${index} content must be a string or content blocks`);
  }
  return content.map((part, partIndex): ModelContextContentBlock => {
    if (!isRecord(part)) throw new Error(`model context message ${index} content[${partIndex}] must be an object`);
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string' && part.image_url.url.length > 0) {
      return { type: 'image_url', image_url: { url: part.image_url.url } };
    }
    throw new Error(`model context message ${index} content[${partIndex}] has an invalid type`);
  });
}

function toolCallsFromAdditional(raw: unknown, index: number): ModelContextToolCall[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`model context message ${index} tool_calls must be an array`);
  if (!raw.length) return undefined;
  return raw.map((call, callIndex) => {
    if (!isRecord(call) || !isRecord(call.function)) {
      throw new Error(`model context message ${index} tool_calls[${callIndex}] must be an object`);
    }
    if (typeof call.id !== 'string' || call.id.length === 0) {
      throw new Error(`model context message ${index} tool_calls[${callIndex}].id must be a non-empty string`);
    }
    if (typeof call.function.name !== 'string' || call.function.name.length === 0) {
      throw new Error(`model context message ${index} tool_calls[${callIndex}].name must be a non-empty string`);
    }
    if (typeof call.function.arguments !== 'string') {
      throw new Error(`model context message ${index} tool_calls[${callIndex}].arguments must be a string`);
    }
    return { id: call.id, name: call.function.name, arguments: call.function.arguments };
  });
}

function serializeAgentMessage(message: BaseMessage, index: number): ModelContextMessage {
  const role = message.getType();
  if (role === 'system') return { role: 'system', content: textContent(message.content, index) };
  if (role === 'human') return { role: 'human', content: humanContent(message.content, index) };
  if (role === 'tool') {
    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw new Error(`model context message ${index} tool_call_id must be a non-empty string`);
    }
    return { role: 'tool', content: textContent(message.content, index), tool_call_id: toolCallId };
  }
  if (role !== 'ai') throw new Error(`model context message ${index} has an invalid role`);
  const canonical: ModelContextMessage = { role: 'ai', content: textContent(message.content, index) };
  const toolCalls = toolCallsFromAdditional(message.additional_kwargs?.tool_calls, index);
  if (toolCalls) canonical.tool_calls = toolCalls;
  const reasoning = message.additional_kwargs?.reasoning_content;
  if (reasoning !== undefined && typeof reasoning !== 'string') {
    throw new Error(`model context message ${index} reasoning_content must be a string`);
  }
  if (typeof reasoning === 'string') canonical.reasoning_content = reasoning;
  return canonical;
}

export function serializeAgentTranscript(messages: readonly BaseMessage[]) {
  return messages.map((message, index) => serializeAgentMessage(message, index));
}
