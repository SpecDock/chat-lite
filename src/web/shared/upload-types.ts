const TEXT_UPLOAD_EXTENSIONS = [
  'txt', 'md', 'json', 'tsv', 'log', 'yaml', 'yml', 'xml',
  'py', 'go', 'java', 'js', 'ts', 'sql', 'sh', 'html', 'css',
] as const;
const IMAGE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_UPLOAD_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const DOCUMENT_UPLOAD_EXTENSIONS = ['csv', 'xlsx', 'pdf'];
const DOCUMENT_UPLOAD_TYPES = [
  'text/csv', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const TEXT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

export const UPLOAD_ACCEPT = [
  ...IMAGE_UPLOAD_TYPES,
  ...DOCUMENT_UPLOAD_TYPES,
  ...[...IMAGE_UPLOAD_EXTENSIONS, ...DOCUMENT_UPLOAD_EXTENSIONS, ...TEXT_UPLOAD_EXTENSIONS].map(extension => `.${extension}`),
].join(',');

export const UPLOAD_DESCRIPTION = '图片、表格、PDF、文本/数据/源码';
export const UPLOAD_HINT = `支持 JPEG、PNG、WEBP 图片、CSV/XLSX 表格、PDF，以及文本/数据/源码（${TEXT_UPLOAD_EXTENSIONS.map(extension => `.${extension}`).join('、')}；每个不超过 5 MiB，须为 UTF-8 且不含 NUL 字符）`;

export function getUploadValidationError(file: Pick<File, 'name' | 'type' | 'size'>): string | undefined {
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (TEXT_UPLOAD_EXTENSIONS.some(supported => supported === extension)) {
    // Content encoding and NUL validation are authoritative on the server.
    return file.size > TEXT_UPLOAD_MAX_BYTES ? '文本/数据/源码文件不能超过 5 MiB' : undefined;
  }
  if (DOCUMENT_UPLOAD_EXTENSIONS.includes(extension)) return undefined;
  if (IMAGE_UPLOAD_TYPES.includes(file.type.toLowerCase())) return undefined;
  if (!file.type && IMAGE_UPLOAD_EXTENSIONS.includes(extension)) return undefined;
  return `不支持此文件类型。${UPLOAD_HINT}`;
}
