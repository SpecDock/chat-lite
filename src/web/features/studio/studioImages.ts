export type StudioImageStatus = 'running' | 'succeeded' | 'failed';

export type StudioReference = {
  id: string;
  url: string;
};

export type StudioImage = {
  id: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  style: string;
  width: number | null;
  height: number | null;
  status: StudioImageStatus;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  references: StudioReference[];
};

export const STUDIO_ASPECTS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const;
export const STUDIO_QUALITIES = ['low', 'standard', 'high'] as const;
export const STUDIO_STYLES = ['vivid', 'natural'] as const;
export const STUDIO_BUSY_MESSAGE = '当前已有 4 张图片正在生成，请等完成后再试。';
export const STUDIO_REFERENCE_LIMIT = 16;

const QUALITY_LABELS: Record<string, string> = {
  auto: 'auto',
  low: 'low',
  medium: 'standard',
  standard: 'standard',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

export function aspectLabel(value: string) {
  return value === 'auto' ? '自动' : value;
}

export function qualityLabel(value: string) {
  return QUALITY_LABELS[value] || value;
}

const STYLE_LABELS: Record<string, string> = {
  vivid: '夸张',
  natural: '自然',
};

export function styleLabel(value: string) {
  return STYLE_LABELS[value] || value;
}

export function studioFileUrl(id: string) {
  return `/api/studio/images/${encodeURIComponent(id)}/file`;
}

export function formatPixels(width: number | null, height: number | null) {
  if (width === null || height === null) return '—';
  return `${width}×${height}`;
}

export function formatDuration(durationMs: number | null) {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)} 毫秒`;
  return `${(durationMs / 1000).toFixed(1)} 秒`;
}

export function studioResultText(item: StudioImage) {
  if (item.error) return item.error;
  if (item.status === 'succeeded') return '生成完成';
  if (item.status === 'failed') return '生成失败';
  return '正在生成';
}

export function studioStatusLabel(status: StudioImageStatus) {
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '生成失败';
  return '正在生成';
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function studioReferences(value: unknown): StudioReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const url = typeof record.url === 'string' ? record.url : '';
    return id && url ? [{ id, url }] : [];
  });
}

export function normalizeStudioImage(value: unknown): StudioImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  const status: StudioImageStatus = record.status === 'succeeded' || record.status === 'failed' || record.status === 'running'
    ? record.status
    : 'running';
  const aspectRatio = record.aspectRatio ?? record.aspect_ratio;
  const durationMs = record.durationMs ?? record.duration_ms;
  const createdAt = record.createdAt ?? record.created_at;
  return {
    id: record.id,
    prompt: typeof record.prompt === 'string' ? record.prompt : '',
    aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : 'auto',
    quality: typeof record.quality === 'string' ? record.quality : 'auto',
    style: record.style === 'natural' ? 'natural' : 'vivid',
    width: numberOrNull(record.width),
    height: numberOrNull(record.height),
    status,
    error: typeof record.error === 'string' && record.error.trim() ? record.error : null,
    durationMs: numberOrNull(durationMs),
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    references: studioReferences(record.references),
  };
}

export function sortStudioImages(items: StudioImage[]) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aOk = Number.isFinite(aTime);
    const bOk = Number.isFinite(bTime);
    if (aOk && bOk && aTime !== bTime) return bTime - aTime;
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
}
