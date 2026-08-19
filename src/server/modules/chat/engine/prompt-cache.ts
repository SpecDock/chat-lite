import { createHash } from 'node:crypto';

type JsonObject = Record<string, any>;

const CACHE_BREAKPOINT = { mode: 'explicit' } as const;
const CACHEABLE_CONTENT_TYPES = new Set(['text', 'image_url', 'input_audio', 'file', 'refusal']);
const CACHEABLE_MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'system', 'developer']);
const CACHE_FIELD_PATTERN = /prompt_cache_(?:key|options|breakpoint)/i;
const UNSUPPORTED_FIELD_PATTERN = /\b(?:unknown|unrecognized|unsupported|unexpected)\b|not\s+(?:recognized|supported)|extra inputs are not permitted/i;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as JsonObject)
    .sort()
    .map(key => [key, canonicalize((value as JsonObject)[key])]));
}

function clearPromptCacheBreakpoints(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) clearPromptCacheBreakpoints(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as JsonObject;
  delete object.prompt_cache_breakpoint;
  for (const child of Object.values(object)) clearPromptCacheBreakpoints(child);
}

function promptCacheKey(body: JsonObject, stableSystemText: string) {
  const payload = canonicalize({
    version: 1,
    model: body.model,
    stableSystemText,
    tools: body.tools,
  });
  return `chat-lite-${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24)}`;
}

export function transformPromptCacheBody(body: JsonObject): JsonObject {
  const transformed = cloneJson(body);
  if (!Array.isArray(transformed.messages)) throw new Error('Prompt cache requires a messages array');
  clearPromptCacheBreakpoints(transformed);

  const stableMessage = transformed.messages.find((message: JsonObject) => message?.role === 'system' || message?.role === 'developer');
  if (!stableMessage || !Array.isArray(stableMessage.content)) {
    throw new Error('Prompt cache requires system/developer content blocks');
  }
  const stableTextBlock = stableMessage.content.find((block: JsonObject) => block?.type === 'text' && typeof block.text === 'string');
  if (!stableTextBlock) throw new Error('Prompt cache requires a stable system text block');
  stableTextBlock.prompt_cache_breakpoint = CACHE_BREAKPOINT;

  let dynamicBreakpointBlock: JsonObject | undefined;
  for (let index = transformed.messages.length - 1; index >= 0 && !dynamicBreakpointBlock; index -= 1) {
    const message = transformed.messages[index] as JsonObject;
    if (!message || !CACHEABLE_MESSAGE_ROLES.has(message.role)) continue;
    if (typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }];
    }
    if (!Array.isArray(message.content)) continue;
    dynamicBreakpointBlock = [...message.content]
      .reverse()
      .find((block: JsonObject) => block !== stableTextBlock && CACHEABLE_CONTENT_TYPES.has(block?.type));
  }
  if (!dynamicBreakpointBlock) throw new Error('Prompt cache messages have no dynamic cacheable block');
  dynamicBreakpointBlock.prompt_cache_breakpoint = CACHE_BREAKPOINT;

  transformed.prompt_cache_options = { mode: 'explicit', ttl: '30m' };
  transformed.prompt_cache_key = promptCacheKey(transformed, stableTextBlock.text);
  return transformed;
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function explicitCacheUnsupported(response: Response) {
  if (response.status !== 400 && response.status !== 422) return false;
  const text = await response.clone().text().catch(() => '');
  return CACHE_FIELD_PATTERN.test(text) && UNSUPPORTED_FIELD_PATTERN.test(text);
}

function safeErrorDetail(value: unknown, fallback: string, maxLength: number) {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, maxLength);
}

export function createPromptCacheFetch(
  nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  let cacheUnsupported = false;

  return async (input, init) => {
    const originalBody = init?.body;
    if (cacheUnsupported || !requestUrl(input).includes('/chat/completions') || typeof originalBody !== 'string') {
      return nativeFetch(input, init);
    }

    let parsed: JsonObject;
    try {
      parsed = JSON.parse(originalBody) as JsonObject;
    } catch {
      return nativeFetch(input, init);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return nativeFetch(input, init);

    let transformedBody: string;
    try {
      transformedBody = JSON.stringify(transformPromptCacheBody(parsed));
    } catch (error) {
      cacheUnsupported = true;
      console.warn('[prompt-cache] transform failed; disabled for this agent run', {
        errorName: safeErrorDetail(error instanceof Error ? error.name : undefined, 'Error', 40),
        errorMessage: safeErrorDetail(error instanceof Error ? error.message : undefined, 'Prompt cache transform failed', 160),
      });
      return nativeFetch(input, init);
    }

    const response = await nativeFetch(input, { ...init, body: transformedBody });
    if (!await explicitCacheUnsupported(response)) return response;

    cacheUnsupported = true;
    console.warn('[prompt-cache] explicit cache fields unsupported; disabled for this agent run', { status: response.status });
    return nativeFetch(input, init);
  };
}
