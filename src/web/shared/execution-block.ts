import type { ExecutionCardDTO } from './types';

// Legacy body tags are unverified text, never server execution metadata.
export type ExecutionBlock = {
  language: string;
  code: string;
  output: string;
};

const EXECUTION_BLOCK_PREFIX = '<chat-lite-execution v="1">';
const EXECUTION_BLOCK_SUFFIX = '</chat-lite-execution>';
const EXECUTION_BLOCK_RE = /<chat-lite-execution v="1">([\s\S]*?)<\/chat-lite-execution>/;
const EXECUTION_BLOCK_GLOBAL_RE = /<chat-lite-execution v="1">[\s\S]*?<\/chat-lite-execution>/g;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string | null {
  if (!BASE64_RE.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (encodeBase64Utf8(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Only use at independent SSE / messages metadata boundaries, not on model text.
export function isExecutionCard(value: unknown): value is ExecutionCardDTO {
  if (!isRecord(value)) return false;
  return typeof value.executionId === 'string' && Boolean(value.executionId.trim())
    && typeof value.status === 'string' && Boolean(value.status.trim())
    && value.language === 'bash'
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
    && typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    && typeof value.truncated === 'boolean'
    && typeof value.showCode === 'boolean'
    && typeof value.showStdout === 'boolean'
    && typeof value.showStderr === 'boolean'
    && (value.code === undefined || typeof value.code === 'string')
    && (value.output === undefined || typeof value.output === 'string')
    && (value.infrastructureError === undefined || typeof value.infrastructureError === 'string')
    && (value.oomKilled === undefined || typeof value.oomKilled === 'boolean')
    && (value.sourceSnapshots === undefined || (Array.isArray(value.sourceSnapshots)
      && value.sourceSnapshots.every(source => isRecord(source) && typeof source.path === 'string' && typeof source.content === 'string')));
}

function isExecutionBlock(value: unknown): value is ExecutionBlock {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every(key => key === 'language' || key === 'code' || key === 'output')
    && typeof value.language === 'string'
    && typeof value.code === 'string'
    && typeof value.output === 'string';
}

export function encodeExecutionBlock(block: ExecutionBlock): string {
  if (!isExecutionBlock(block)) throw new TypeError('Invalid execution block');
  const json = JSON.stringify({
    language: block.language,
    code: block.code,
    output: block.output,
  }) || '';
  return `${EXECUTION_BLOCK_PREFIX}${encodeBase64Utf8(json)}${EXECUTION_BLOCK_SUFFIX}`;
}

export function decodeExecutionBlock(value: string): ExecutionBlock | null {
  const source = String(value || '').trim();
  const tagged = source.match(EXECUTION_BLOCK_RE);
  const payload = tagged ? tagged[1] : source;
  const json = decodeBase64Utf8(payload);
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isExecutionBlock(parsed)
      ? { language: parsed.language, code: parsed.code, output: parsed.output }
      : null;
  } catch {
    return null;
  }
}

export function stripExecutionBlocks(value: string): string {
  return String(value || '').replace(EXECUTION_BLOCK_GLOBAL_RE, '').trim();
}
