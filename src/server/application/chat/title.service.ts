import { ChatOpenAI } from '@langchain/openai';
import { emitToUser } from '../../interfaces/http/events.js';
import { safeTitle } from '../../infrastructure/auth/security.js';
import { updateConversationTitle } from '../../infrastructure/chat/title.repo.js';

export function titleApiKey() {
  return process.env.TITLE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
}

export function titleBaseUrl() {
  return process.env.TITLE_BASE_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
}

export function titleModelName() {
  return process.env.TITLE_MODEL_NAME || process.env.MODEL_NAME || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export function createTitleModel() {
  const apiKey = titleApiKey();
  if (!apiKey) throw new Error('未配置标题模型 API Key：请设置 TITLE_API_KEY、MODEL_API_KEY 或 OPENAI_API_KEY');
  return new ChatOpenAI({
    apiKey,
    model: titleModelName(),
    temperature: 0.2,
    maxRetries: 0,
    configuration: { baseURL: titleBaseUrl() }
  });
}

function cleanTitle(value: string) {
  return value
    .replace(/^标题[:：]\s*/i, '')
    .replace(/["“”'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24) || '新会话';
}

async function generateShortTitle(input: string) {
  const apiKey = titleApiKey();
  if (!apiKey) {
    console.warn('[title] TITLE_API_KEY/MODEL_API_KEY is missing, using safeTitle fallback');
    return safeTitle(input);
  }
  const model = createTitleModel();
  const result = await model.invoke([
    { role: 'system', content: '你只负责给聊天会话生成中文短标题。根据首轮用户问题和助手回复提炼主题。输出 4 到 12 个中文字符或等长短语，不要标点，不要解释，不要加引号。' },
    { role: 'user', content: input.slice(0, 600) }
  ]);
  const content = Array.isArray(result.content) ? result.content.map(part => typeof part === 'string' ? part : ('text' in part ? String(part.text) : '')).join('') : String(result.content || '');
  return cleanTitle(content);
}

export function scheduleConversationTitle(userId: string, conversationId: string, firstUserInput: string, assistantOutput = '') {
  void (async () => {
    try {
      console.info('[title] generation scheduled', { conversationId });
      const source = assistantOutput.trim()
        ? `用户：${firstUserInput}\n\n助手：${assistantOutput.slice(0, 900)}`
        : firstUserInput;
      const title = await generateShortTitle(source);
      if (!updateConversationTitle(userId, conversationId, title)) return;
      emitToUser(userId, 'conversations_changed', { conversationId, reason: 'title_updated' });
      console.info('[title] generation completed', { conversationId });
    } catch {
      console.warn('[title] generation failed', { conversationId });
    }
  })();
}
