import { ChatOpenAI } from '@langchain/openai';
import { createPromptCacheFetch } from './prompt-cache.js';

export function modelApiKey() {
  return process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
}

export function modelBaseUrl() {
  return process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
}

export function modelName() {
  return process.env.MODEL_NAME || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export function createChatModel(options?: { promptCache?: boolean; reasoningReplay?: ReadonlyMap<string, string> }) {
  const apiKey = modelApiKey();
  if (!apiKey) throw new Error('未配置模型 API Key：请设置 MODEL_API_KEY 或 OPENAI_API_KEY');
  const promptCacheFetch = options?.promptCache
    ? createPromptCacheFetch(globalThis.fetch.bind(globalThis), options.reasoningReplay)
    : undefined;
  return new ChatOpenAI({
    model: modelName(),
    apiKey,
    temperature: Number(process.env.MODEL_TEMPERATURE || 0.3),
    maxRetries: 0,
    configuration: { baseURL: modelBaseUrl(), ...(promptCacheFetch ? { fetch: promptCacheFetch } : {}) }
  });
}

export function textFromModelMessage(message: unknown) {
  if (typeof message === 'string') return message;
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text || '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
