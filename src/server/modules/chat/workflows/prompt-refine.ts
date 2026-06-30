import type { MessageDTO } from '../../../../shared/types.js';
import { createChatModel, textFromModelMessage } from '../model.js';

const REFINE_SYSTEM_T2I = `你是 chat-lite 的图像 prompt 工程师。把用户的简短请求改写成适合图像模型的详细 prompt。

要求：
- 只输出最终的 prompt 文本本身，不要引号、不要解释、不要 Markdown、不要编号。
- 使用与用户相同的语言（中文请求就用中文 prompt）。
- 包含：主体、动作、构图、风格、光线、画质、镜头/视角、关键细节。
- 如果上下文里有图片生成历史，可以参考前图主体特征以保持一致。
- 直接写图像模型能理解的描述性文字。`;

const REFINE_SYSTEM_I2I = `你是 chat-lite 的图像编辑 prompt 工程师。用户会基于一张原图做修改。

要求：
- 只输出最终的编辑 prompt 文本本身，不要引号、不要解释、不要 Markdown。
- 使用与用户相同的语言。
- 保留原图主体身份、构图、风格一致性的同时，精准表达用户的修改诉求。
- 包含：保留什么、改什么、最终效果。
- 如果提供了原图描述，结合它写 prompt。`;

const REFINE_SYSTEM_BATCH = `你是 chat-lite 的批量图像 prompt 工程师。用户请求一次生成多张不同的图。

要求：
- 只输出 JSON 数组，元素是字符串 prompt。
- 不要 Markdown 代码块、不要解释。
- 数组长度必须等于用户指定的张数。
- 每张图风格/主体/视角/构图要明显不同。
- 使用与用户相同的语言。`;

function buildConversationContext(history: Pick<MessageDTO, 'role' | 'content'>[] = []) {
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').replace(/<\/?think>/g, '').slice(0, 400)}`)
    .join('\n');
}

async function callMainAI(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const result = await createChatModel().invoke(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { signal }
  );
  return textFromModelMessage(result).trim();
}

function stripWrappingQuotes(text: string) {
  return text.replace(/^["'`]+|["'`]+$/g, '').trim();
}

export async function refineTextImagePrompt(input: {
  userRequest: string;
  history: Pick<MessageDTO, 'role' | 'content'>[];
  signal?: AbortSignal;
}): Promise<string> {
  const userPrompt = [
    '最近上下文:',
    buildConversationContext(input.history) || '(无)',
    '',
    `用户当前请求: ${input.userRequest}`,
    '',
    '请改写为适合图像模型的详细 prompt。'
  ].join('\n');

  const refined = await callMainAI(REFINE_SYSTEM_T2I, userPrompt, input.signal);
  return stripWrappingQuotes(refined) || input.userRequest.trim();
}

export async function refineImageEditPrompt(input: {
  userRequest: string;
  history: Pick<MessageDTO, 'role' | 'content'>[];
  sourceDescription?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const userPrompt = [
    '最近上下文:',
    buildConversationContext(input.history) || '(无)',
    '',
    `原图描述: ${input.sourceDescription || '(未提供)'}`,
    '',
    `用户编辑请求: ${input.userRequest}`,
    '',
    '请改写为保留原图主体、只表达修改诉求的编辑 prompt。'
  ].join('\n');

  const refined = await callMainAI(REFINE_SYSTEM_I2I, userPrompt, input.signal);
  return stripWrappingQuotes(refined) || input.userRequest.trim();
}

export async function refineTextImagePrompts(input: {
  userRequest: string;
  history: Pick<MessageDTO, 'role' | 'content'>[];
  count: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const safeCount = Math.max(1, Math.min(input.count, 6));
  const userPrompt = [
    '最近上下文:',
    buildConversationContext(input.history) || '(无)',
    '',
    `用户请求: ${input.userRequest}`,
    '',
    `请输出恰好 ${safeCount} 个不同的图像生成 prompt，作为 JSON 字符串数组返回。`
  ].join('\n');

  const raw = await callMainAI(REFINE_SYSTEM_BATCH, userPrompt, input.signal);

  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return Array(safeCount).fill(input.userRequest.trim());
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return Array(safeCount).fill(input.userRequest.trim());
    const strings = parsed
      .map((item: unknown) => typeof item === 'string' ? stripWrappingQuotes(item) : '')
      .filter((s: string) => s.length > 0)
      .slice(0, safeCount);
    while (strings.length < safeCount) strings.push(input.userRequest.trim());
    return strings;
  } catch {
    return Array(safeCount).fill(input.userRequest.trim());
  }
}
