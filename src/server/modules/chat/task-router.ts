import { z } from 'zod';
import { ChatOpenAI } from '@langchain/openai';
import type { MessageDTO } from '../../../shared/types.js';
import { chooseSourceAttachmentId, imageCandidates } from './image-selection.service.js';
import { routerHistoryLimit } from './history-limits.js';

export type TaskIntent = 'chat' | 'vision_qa' | 'image_edit' | 'text_to_image' | 'web_search' | 'mixed';

export type TaskRoute = {
  intent: TaskIntent;
  needVision: boolean;
  needImageEdit: boolean;
  needSearch: boolean;
  sourceAttachmentId?: string;
  confidence: number;
};

const ROUTE_SCHEMA = z.object({
  intent: z.enum(['chat', 'vision_qa', 'image_edit', 'text_to_image', 'web_search', 'mixed']),
  needVision: z.boolean().default(false),
  needImageEdit: z.boolean().default(false),
  needSearch: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.5)
});

function routerApiKey() {
  return process.env.TITLE_API_KEY || process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || '';
}

function routerBaseUrl() {
  return process.env.TITLE_BASE_URL || process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
}

function routerModelName() {
  return process.env.TITLE_MODEL_NAME || process.env.MODEL_NAME || process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function createRouterModel() {
  const apiKey = routerApiKey();
  if (!apiKey) throw new Error('未配置路由模型 API Key：请设置 TITLE_API_KEY 或 MODEL_API_KEY');
  return new ChatOpenAI({
    apiKey,
    model: routerModelName(),
    temperature: Number(process.env.TITLE_MODEL_TEMPERATURE || 0.2),
    configuration: { baseURL: routerBaseUrl() }
  });
}

function ruleRoute(input: string, attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[] = []): TaskRoute | undefined {
  const sourceAttachmentId = chooseSourceAttachmentId(input, attachmentIds, history);
  const hasImage = !!sourceAttachmentId;
  const wantsEdit = /(添加|加上|放上|贴纸|爱心|修改|编辑|改图|改成|换背景|换风格|去掉|删除|擦除|重绘|动漫化|图生图|参考原图|根据.*图|头像|海报|插画)/.test(input)
    && !/(不要生成|不用生成|不要改|只识别|只分析|只描述)/.test(input);
  if (hasImage && wantsEdit) return { intent: 'image_edit', needVision: /先.*(说|描述|识别|分析)|这是什么|图片.*什么/.test(input), needImageEdit: true, needSearch: false, sourceAttachmentId, confidence: 0.95 };
  if (hasImage && /(这是什么|识别|分析|解释|解题|题目|作业|截图|图片里|图中|描述)/.test(input)) return { intent: 'vision_qa', needVision: true, needImageEdit: false, needSearch: false, sourceAttachmentId, confidence: 0.9 };
  if (!hasImage && /(画一张|生成.*图|文生图|logo|海报|头像|插画|图片生成)/.test(input)) return { intent: 'text_to_image', needVision: false, needImageEdit: false, needSearch: false, confidence: 0.9 };
  if (/(搜索|联网|最新|今天|新闻|网页|网址|价格|政策|实时|搜一下|查一下|帮我搜|帮我查|找一下|了解一下|百度|谷歌|最近怎么样|search|look up|find out|google it)/i.test(input)) return { intent: 'web_search', needVision: false, needImageEdit: false, needSearch: true, confidence: 0.85 };
  return undefined;
}

function isPureTextTask(input: string) {
  return /(翻译|润色|改写|总结|解释这段|写代码|代码|bug|报错|正则|SQL|函数|组件|作文|邮件|文案|闲聊|讲个笑话|你好|hello|hi)/i.test(input);
}

function wantsExternalKnowledge(input: string) {
  return /(搜索|联网|最新|今天|新闻|网页|网址|价格|政策|实时|搜一下|查一下|帮我搜|帮我查|找一下|了解一下|百度|谷歌|最近怎么样|现在.*情况|有没有.*消息|search|look up|find out|google it)/i.test(input);
}

function historyContext(history: Pick<MessageDTO, 'role' | 'content'>[] = []) {
  return history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-routerHistoryLimit())
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 500)}`)
    .join('\n');
}

function safeRoute(value: unknown, attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[] = [], input = ''): TaskRoute | undefined {
  const parsed = ROUTE_SCHEMA.safeParse(value);
  if (!parsed.success) return undefined;
  return { ...parsed.data, sourceAttachmentId: chooseSourceAttachmentId(input, attachmentIds, history) };
}

function textFromModelMessage(message: unknown) {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text || '') : '')).join('');
  }
  return '';
}

function parseJsonRoute(text: string, attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[], input: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return safeRoute(JSON.parse(match[0]), attachmentIds, history, input);
  } catch {
    return undefined;
  }
}

export async function routeTask(input: string, attachmentIds: string[], history: Pick<MessageDTO, 'role' | 'content'>[] = [], signal?: AbortSignal): Promise<TaskRoute> {
  const ruled = ruleRoute(input, attachmentIds, history);
  try {
    const model = createRouterModel();
    const result = await model.invoke([
      { role: 'system', content: `你是 chat-lite 的任务路由器。只判断应该进入哪个执行模式，不回答用户问题。

你必须只输出一个 JSON 对象，不要 Markdown，不要解释，不要代码块。
JSON 字段：
{
  "intent": "chat|vision_qa|image_edit|text_to_image|web_search|mixed",
  "needVision": boolean,
  "needImageEdit": boolean,
  "needSearch": boolean,
  "confidence": 0到1之间的数字
}

可选 intent：
- chat：普通聊天、解释、写作、翻译、代码问答，不需要外部工具。
- vision_qa：有图片，用户想知道图片内容、截图含义、题目解答、让你先看看/说说/分析图。
- image_edit：有图片(也有可能是此次发送无图片但是上下文有图片)，用户想基于原图生成/修改/加元素/换风格/保留人物/做头像/贴纸/修图。用户可能不会直说“图生图”，例如“给她戴顶帽子”“中间加个爱心”“变得像动漫一点”“背景换成海边”。
- 如果最近上下文里助手要求“请上传需要编辑的原图”，而当前用户只上传图片或空文本上传图片，应优先判断为 image_edit，并把本轮上传图片作为源图。
- 如果用户说“上文那张/刚才那张/之前那张/图2/第二张”，需要根据图片候选顺序选择历史图片作为源图。
- text_to_image：没有源图，用户想生成图片、画图、logo、海报、头像、插画。
- web_search：用户需要最新/实时/联网/网页/新闻/价格/政策/资料来源。
- mixed：需要多个工具或步骤组合，例如先搜索再画图、先看图再搜索、先识图再生成复杂内容。

明确任务优先选固定 workflow；模糊多步骤选 mixed；普通闲聊选 chat。` },
      { role: 'user', content: `最近上下文：\n${historyContext(history) || '(无)'}\n\n图片候选顺序：${imageCandidates(attachmentIds, history).map((id, i) => `图${i + 1}=${id}${attachmentIds.includes(id) ? '(本轮上传)' : '(历史图片)'}`).join('；') || '(无)'}\n\n当前用户输入：${input || '(空)'}\n本轮附件图片 ID：${attachmentIds.join(', ') || '(无)'}\n本轮附件图片数量：${attachmentIds.length}` }
    ], { signal });
    const routed = parseJsonRoute(textFromModelMessage(result), attachmentIds, history, input);
    if (routed && routed.confidence >= 0.45) return routed;
    if (ruled) return ruled;
    if (routed && routed.confidence < 0.45 && !attachmentIds.length && !isPureTextTask(input)) {
      if (routed.needSearch || wantsExternalKnowledge(input) || routed.intent === 'web_search') {
        return { intent: 'web_search', needVision: false, needImageEdit: false, needSearch: true, confidence: Math.max(routed.confidence, 0.45) };
      }
    }
    return routed || { intent: 'chat', needVision: false, needImageEdit: false, needSearch: false, confidence: 0.3 };
  } catch (error) {
    console.warn('[router] model route failed, fallback rules:', error instanceof Error ? error.message : error);
    return ruled || { intent: 'chat', needVision: false, needImageEdit: false, needSearch: false, confidence: 0.2 };
  }
}
