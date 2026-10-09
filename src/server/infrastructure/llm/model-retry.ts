export const EMPTY_RESPONSE = 'EMPTY_RESPONSE' as const;
export const PARTIAL_FINAL_STREAM = 'PARTIAL_FINAL_STREAM' as const;

export type ModelErrorKind =
  | 'aborted'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'connection'
  | 'server'
  | 'empty'
  | 'program';

export type ModelErrorClassification = {
  retryable: boolean;
  kind: ModelErrorKind;
  status?: number;
  codes: string[];
  requestId?: string;
  retryAfterMs?: number;
  safeMessage: string;
};

export type AgentStage =
  | 'model_create'
  | 'tool_registry'
  | 'bind_tools'
  | 'rag_retrieve'
  | 'build_messages'
  | 'image_candidates'
  | 'chat_boundary';

export class EmptyResponseError extends Error {
  readonly code = EMPTY_RESPONSE;

  constructor() {
    super('Model returned an empty response');
    this.name = 'EmptyResponseError';
  }
}

export class PartialFinalStreamError extends Error {
  readonly code = PARTIAL_FINAL_STREAM;

  constructor(cause: unknown) {
    super('Final response stream was interrupted after content was sent', { cause });
    this.name = 'PartialFinalStreamError';
  }
}

export function createEmptyResponseError() {
  return new EmptyResponseError();
}

export function createPartialFinalStreamError(cause: unknown) {
  return new PartialFinalStreamError(cause);
}

export function isPartialFinalStreamError(error: unknown): error is PartialFinalStreamError {
  return error instanceof PartialFinalStreamError
    || (isRecord(error) && (error.code === PARTIAL_FINAL_STREAM || error.name === 'PartialFinalStreamError'));
}

export function modelMaxAttempts(): number {
  const raw = process.env.MODEL_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const value = Number.isFinite(parsed) ? Math.floor(parsed) : 2;
  return Math.min(3, Math.max(1, value));
}

type ErrorLayer = {
  name?: string;
  message?: string;
  code?: string;
  status?: number;
  requestId?: string;
  headers?: unknown;
};

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function');
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function statusValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (isRecord(headers) && typeof headers.get === 'function') {
    const value = headers.get(name);
    return stringValue(value);
  }
  if (!isRecord(headers)) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) return stringValue(value[0]);
      return stringValue(value);
    }
  }
  return undefined;
}

function errorLayers(error: unknown): ErrorLayer[] {
  const layers: ErrorLayer[] = [];
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  while (queue.length && layers.length < 16) {
    const { value: current, depth } = queue.shift()!;
    if (current == null || seen.has(current) || depth > 6) continue;
    seen.add(current);
    if (!isRecord(current)) {
      layers.push({ message: stringValue(current) });
      continue;
    }
    const response = isRecord(current.response) ? current.response : undefined;
    const headers = current.headers ?? response?.headers;
    layers.push({
      name: stringValue(current.name),
      message: stringValue(current.message),
      code: stringValue(current.code) ?? stringValue(current.type),
      status: statusValue(current.status) ?? statusValue(current.statusCode)
        ?? statusValue(response?.status) ?? statusValue(response?.statusCode),
      requestId: stringValue(current.requestId ?? current.requestID ?? current.request_id)
        ?? headerValue(headers, 'x-request-id')
        ?? headerValue(headers, 'request-id'),
      headers
    });
    const next: unknown[] = [current.error, current.cause, current.response];
    if (isRecord(current.response)) {
      next.push(current.response.data);
      if (isRecord(current.response.data)) next.push(current.response.data.error);
    }
    if (isRecord(current.data)) next.push(current.data.error);
    const aggregateErrors = current instanceof AggregateError ? current.errors : current.errors;
    if (Array.isArray(aggregateErrors)) next.push(...aggregateErrors.slice(0, 8));
    for (const value of next) {
      if (value != null && !seen.has(value) && queue.length < 24) queue.push({ value, depth: depth + 1 });
    }
  }
  return layers;
}

function parseRetryAfterMs(layers: ErrorLayer[]): number | undefined {
  for (const layer of layers) {
    const milliseconds = headerValue(layer.headers, 'retry-after-ms');
    if (milliseconds !== undefined) {
      const parsed = Number(milliseconds);
      if (Number.isFinite(parsed)) return Math.round(parsed);
    }
    const retryAfter = headerValue(layer.headers, 'retry-after');
    if (retryAfter === undefined) continue;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

export function safeModelErrorSummary(kind: ModelErrorKind): string {
  switch (kind) {
    case 'aborted': return 'Model request aborted';
    case 'auth': return 'Model authentication failed';
    case 'quota': return 'Model quota unavailable';
    case 'rate_limit': return 'Model request rate limited';
    case 'timeout': return 'Model request timed out';
    case 'connection': return 'Model connection failed';
    case 'server': return 'Model provider server failed';
    case 'empty': return 'Model returned no usable content';
    case 'program': return 'Model request rejected';
  }
}

export function safeCauseCodes(codes: readonly string[] | undefined): string[] | undefined {
  if (!codes) return undefined;
  const allowed = new Set([
    EMPTY_RESPONSE, PARTIAL_FINAL_STREAM,
    'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_ABORTED'
  ]);
  const safe = Array.from(new Set(codes.map(code => code.toUpperCase()).filter(code => allowed.has(code)))).slice(0, 8);
  return safe.length ? safe : undefined;
}

function safeErrorName(name: string | undefined): string | undefined {
  return name && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : undefined;
}

function safeRequestId(requestId: string | undefined): string | undefined {
  return requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : undefined;
}

export function classifyModelError(error: unknown, signal?: AbortSignal): ModelErrorClassification {
  const layers = errorLayers(error);
  const names = layers.map(layer => layer.name).filter((value): value is string => Boolean(value));
  const messages = layers.map(layer => layer.message).filter((value): value is string => Boolean(value));
  const codes = Array.from(new Set(layers.map(layer => layer.code).filter((value): value is string => Boolean(value))));
  const status = layers.find(layer => layer.status !== undefined)?.status;
  const requestId = layers.find(layer => layer.requestId)?.requestId;
  const retryAfterMs = parseRetryAfterMs(layers);
  const combined = [...names, ...messages, ...codes].join(' | ');
  const result = (kind: ModelErrorKind, retryable: boolean): ModelErrorClassification => ({
    retryable,
    kind,
    status,
    codes,
    requestId: safeRequestId(requestId),
    retryAfterMs,
    safeMessage: safeModelErrorSummary(kind)
  });

  if (signal?.aborted || /AbortError|APIUserAbortError/i.test(combined)) return result('aborted', false);
  if (codes.includes(EMPTY_RESPONSE) || /EmptyResponseError/.test(combined)) return result('empty', true);
  if (codes.some(code => /^(?:insufficient_quota|quota_exceeded|billing_hard_limit_reached)$/i.test(code))) {
    return result('quota', false);
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return result('auth', false);
    if (status === 400 || status === 404 || status === 422) return result('program', false);
    if (status === 429) return result('rate_limit', retryAfterMs !== undefined && retryAfterMs >= 0 && retryAfterMs <= 5000);
    if (status === 408) return result('timeout', true);
    if (status === 409 || (status >= 500 && status <= 599)) return result('server', true);
    return result('program', false);
  }
  if (/insufficient_quota|余额不足|额度不足|balance\s*(?:is\s*)?(?:insufficient|low)|\bquota\b/i.test(combined)) {
    return result('quota', false);
  }
  if (/authentication|unauthori[sz]ed|invalid(?:_|\s)*(?:api(?:_|\s)*)?key|invalid.*token|permission denied|missing(?:_|\s)*(?:model(?:_|\s)*)?api(?:_|\s)*key|未配置模型\s*API\s*Key|缺少\s*API\s*Key/i.test(combined)) {
    return result('auth', false);
  }
  if (/context[_\s-]*(?:length|window)|maximum context|tool[_\s-]*schema|invalid[_\s-]*(?:arg(?:ument)?s?|request|parameter)|bad request/i.test(combined)) {
    return result('program', false);
  }
  if (/APIConnectionTimeoutError|TimeoutError|ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(combined)
    || codes.some(code => /^(?:ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/i.test(code))) {
    return result('timeout', true);
  }
  if (/APIConnectionError|ECONNRESET|EPIPE|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|UND_ERR_ABORTED/i.test(combined)
    || codes.some(code => /^(?:ECONNRESET|EPIPE|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|UND_ERR_ABORTED)$/i.test(code))
    || /terminated|socket hang up|fetch failed|other side closed|connection error/i.test(combined)) {
    return result('connection', true);
  }
  return result('program', false);
}

export function retryDelayMs(classification: ModelErrorClassification): number | undefined {
  if (!classification.retryable) return undefined;
  if (classification.kind === 'rate_limit') return classification.retryAfterMs;
  return 300 + Math.floor(Math.random() * 501);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ModelAttemptLog = {
  callId: string;
  conversationId: string;
  phase: 'decision' | 'final';
  recursion: number;
  attempt: number;
  maxAttempts: number;
  model: string;
  outcome: string;
  sawText: boolean;
  committedText: boolean;
  sawToolDelta: boolean;
  elapsedMs: number;
  retryDelayMs?: number;
  errorKind?: ModelErrorKind;
  errorName?: string;
  causeCodes?: string[];
  status?: number;
  requestId?: string;
};

export function logModelAttempt(entry: ModelAttemptLog): void {
  const payload = {
    callId: entry.callId,
    conversationId: entry.conversationId,
    phase: entry.phase,
    recursion: entry.recursion,
    attempt: entry.attempt,
    maxAttempts: entry.maxAttempts,
    model: entry.model,
    outcome: entry.outcome,
    sawText: entry.sawText,
    committedText: entry.committedText,
    sawToolDelta: entry.sawToolDelta,
    elapsedMs: Math.max(0, Math.round(entry.elapsedMs)),
    retryDelayMs: entry.retryDelayMs,
    errorKind: entry.errorKind,
    errorName: safeErrorName(entry.errorName),
    causeCodes: safeCauseCodes(entry.causeCodes),
    status: entry.status,
    requestId: safeRequestId(entry.requestId)
  };
  const method = entry.outcome === 'success' ? console.info : console.warn;
  method('[model-attempt]', payload);
}

export type AgentStageLog = {
  callId: string;
  conversationId: string;
  stage: AgentStage;
  outcome: string;
  elapsedMs: number;
  errorKind?: ModelErrorKind;
  status?: number;
  codes?: string[];
  requestId?: string;
};

export function logAgentStage(entry: AgentStageLog): void {
  const payload: AgentStageLog = {
    callId: entry.callId,
    conversationId: entry.conversationId,
    stage: entry.stage,
    outcome: entry.outcome,
    elapsedMs: Math.max(0, Math.round(entry.elapsedMs)),
    errorKind: entry.errorKind,
    status: entry.status,
    codes: safeCauseCodes(entry.codes),
    requestId: safeRequestId(entry.requestId)
  };
  const method = entry.outcome === 'success' ? console.info : console.warn;
  method('[agent-stage]', payload);
}
