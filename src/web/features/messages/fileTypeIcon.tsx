import type { ReactNode } from 'react';

type FileKind = 'sheet' | 'doc' | 'slides' | 'pdf' | 'archive' | 'text' | 'code' | 'audio' | 'video' | 'generic';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const KINDS: Record<Exclude<FileKind, 'generic'>, { ext: string[]; fill: string; label: string }> = {
  sheet: { ext: ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'tsv'], fill: '#217346', label: '表' },
  doc: { ext: ['doc', 'docx', 'odt', 'rtf'], fill: '#2b579a', label: '文' },
  slides: { ext: ['ppt', 'pptx', 'odp'], fill: '#d24726', label: '演' },
  pdf: { ext: ['pdf'], fill: '#d32f2f', label: 'PDF' },
  archive: { ext: ['zip', 'rar', '7z', 'tar', 'gz'], fill: '#c48a12', label: '档' },
  text: { ext: ['txt', 'md'], fill: '#5f6b66', label: '字' },
  code: { ext: ['json', 'js', 'ts', 'py', 'go', 'html', 'css'], fill: '#3d6b8a', label: '码' },
  audio: { ext: ['mp3', 'wav', 'm4a', 'flac'], fill: '#7a4ea3', label: '音' },
  video: { ext: ['mp4', 'mov', 'webm', 'mkv'], fill: '#8a4b2f', label: '视' },
};

export function fileExtension(name: string) {
  const clean = name.split('?')[0].split('#')[0].split('/').pop() || '';
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

export function isPreviewImage(name: string) {
  const ext = fileExtension(name);
  return ext === '' || IMAGE_EXT.has(ext);
}

export function fileKind(name: string): FileKind {
  const ext = fileExtension(name);
  for (const [kind, item] of Object.entries(KINDS) as Array<[Exclude<FileKind, 'generic'>, { ext: string[] }]>) {
    if (item.ext.includes(ext)) return kind;
  }
  return 'generic';
}

function iconSvg(name: string, size: number) {
  const kind = fileKind(name);
  const fill = kind === 'generic' ? '#6b7280' : KINDS[kind].fill;
  const label = kind === 'generic' ? '' : KINDS[kind].label;
  const mark = kind === 'sheet'
    ? '<path d="M8 14h6M8 18h6M8 22h6M14 14v8" stroke="#fff" stroke-width="1.4"/>'
    : `<text x="16" y="21" text-anchor="middle" fill="#fff" font-size="${label.length > 1 ? 7 : 11}" font-family="sans-serif">${label}</text>`;
  return `<svg class="file-type-icon" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><path fill="${fill}" d="M8 3h11l7 7v19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path fill="#fff" fill-opacity=".9" d="M19 3v7h7"/><path fill="${fill}" d="M19 3l7 7h-7z"/>${mark}</svg>`;
}

export function fileTypeIconHtml(name: string, size = 28) {
  return iconSvg(name, size);
}

export function FileTypeIcon({ name, size = 28 }: { name: string; size?: number }): ReactNode {
  return <span className="file-type-icon-wrap" dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }} />;
}
