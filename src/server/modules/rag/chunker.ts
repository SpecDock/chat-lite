import { ragConfig } from './rag.config.js';

export type RagChunk = {
  text: string;
  type?: string;
  importance?: number;
};

const MIN_CHUNK_LEN = 40;
const MAX_FALLBACK_LEN_FALLBACK = 600;
const MIN_SEMANTIC_CHUNK_LEN = 200;

export function cleanForIndexing(text: string, maxChars: number) {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > maxChars) cleaned = cleaned.slice(0, maxChars);
  return cleaned;
}

export function simpleChunk(text: string, maxChars: number): RagChunk[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const effective = Math.max(80, maxChars || MAX_FALLBACK_LEN_FALLBACK);
  if (cleaned.length <= effective) return [{ text: cleaned, type: 'text', importance: 0.5 }];
  const out: RagChunk[] = [];
  const sentenceRegex = /[^。！？!?\.]+[。！？!?\.]?/g;
  const sentences = cleaned.match(sentenceRegex) || [cleaned];
  let buffer = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if ((buffer + piece).length > effective && buffer) {
      out.push({ text: buffer.trim(), type: 'text', importance: 0.5 });
      buffer = piece;
    } else {
      buffer = buffer ? `${buffer} ${piece}` : piece;
    }
  }
  if (buffer.trim()) out.push({ text: buffer.trim(), type: 'text', importance: 0.5 });
  return out.filter(c => c.text.length >= MIN_CHUNK_LEN);
}

function chunkerConfigured(): boolean {
  const cfg = ragConfig();
  return !!cfg.chunker.apiKey && !!cfg.chunker.model;
}

function safeParseChunks(raw: string): RagChunk[] | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const candidates = [cleaned];
  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(cleaned.slice(objectStart, objectEnd + 1));
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
  let parsed: any;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {}
  }
  if (!parsed) return null;
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.chunks) ? parsed.chunks : null;
  if (!arr) return null;
  const out: RagChunk[] = [];
  for (const item of arr) {
    const text = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && typeof item.text === 'string'
        ? item.text.trim()
        : '';
    if (!text || text.length < MIN_CHUNK_LEN) continue;
    const type = item && typeof item === 'object' && typeof item.type === 'string' ? item.type.slice(0, 32) : 'text';
    const importance = item && typeof item === 'object' && typeof item.importance === 'number' && Number.isFinite(item.importance)
      ? Math.max(0, Math.min(1, item.importance))
      : 0.5;
    out.push({ text, type, importance });
  }
  return out.length ? out : null;
}

export async function semanticChunk(text: string, maxChars: number): Promise<RagChunk[]> {
  const cfg = ragConfig();
  if (!cfg.chunkEnabled) return simpleChunk(text, maxChars);
  if (!chunkerConfigured()) return simpleChunk(text, maxChars);
  if (text.trim().length < MIN_SEMANTIC_CHUNK_LEN) return simpleChunk(text, maxChars);
  const effective = Math.max(80, maxChars);
  const trimmed = text.length > effective * 4 ? text.slice(0, effective * 4) : text;
  const url = cfg.chunker.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.chunker.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.chunker.model,
        temperature: cfg.chunker.temperature,
        messages: [
          {
            role: 'system',
            content: `你是 RAG 语义切块器，只负责把文本切成便于向量检索的独立片段。

强制输出规则：
1. 只能输出一个合法 JSON 对象，不能输出 Markdown、代码块、解释、前缀、后缀。
2. JSON 顶层必须是：{"chunks":[...]}
3. chunks 必须是数组。每项必须包含：
   - "text": string，保留原文含义，不能杜撰，不能总结成原文没有的信息。
   - "type": string，只能用 text/question/answer/preference/fact/instruction/decision/config/error 之一。
   - "importance": number，0 到 1。
4. 如果文本很短或不适合切分，也必须返回一个 chunk。
5. 每个 chunk 的 text 尽量不少于 ${MIN_CHUNK_LEN} 个中文字符；不要把一句话或一个短事实切成多个碎片。若原文总长度少于 ${MIN_CHUNK_LEN} 字，返回一个 chunk。
6. 每个 text 不超过用户给定的最大段长度；太长时按语义边界拆成多段。
7. 不要丢失用户偏好、配置值、架构决策、错误原因、操作步骤等长期有用信息。

合法输出示例：
{"chunks":[{"text":"用户希望 chat-lite 保持轻量，不要过度设计。","type":"preference","importance":0.9}]}`
          },
          {
            role: 'user',
            content: `最大段长度：${effective} 字\n\n文本：\n${trimmed}`
          }
        ]
      })
    });
  } catch (error) {
    console.warn('[rag] semantic chunker request failed, fallback:', error instanceof Error ? error.message : error);
    return simpleChunk(text, maxChars);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.warn(`[rag] semantic chunker returned ${response.status}, fallback: ${detail.slice(0, 160)}`);
    return simpleChunk(text, maxChars);
  }
  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('[rag] semantic chunker parse failed, fallback:', error instanceof Error ? error.message : error);
    return simpleChunk(text, maxChars);
  }
  const content = (() => {
    const message = payload?.choices?.[0]?.message;
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part: any) => typeof part === 'string' ? part : (part?.text ? String(part.text) : '')).join('');
    }
    return '';
  })();
  const parsed = safeParseChunks(content);
  if (!parsed) {
    console.warn(`[rag] semantic chunker output invalid, falling back to simple chunk: ${content.slice(0, 200)}`);
    return simpleChunk(text, maxChars);
  }
  return parsed.map(c => ({
    text: c.text.length > effective ? c.text.slice(0, effective) : c.text,
    type: c.type,
    importance: c.importance
  }));
}
