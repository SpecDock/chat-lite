export const SHIKI_MAX_BYTES = 100 * 1024;

const commonAliases: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  sh: 'shellscript',
  shell: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  cc: 'cpp',
  'c++': 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  csharp: 'csharp',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

const extensions: Record<string, string> = {
  javascript: 'js', jsx: 'jsx', typescript: 'ts', tsx: 'tsx', shellscript: 'sh',
  cpp: 'cpp', csharp: 'cs', python: 'py', ruby: 'rb', rust: 'rs', go: 'go', java: 'java',
  kotlin: 'kt', swift: 'swift', php: 'php', html: 'html', css: 'css', scss: 'scss',
  json: 'json', yaml: 'yml', markdown: 'md', sql: 'sql', xml: 'xml', vue: 'vue', svelte: 'svelte',
};

export type LightweightLanguage = {
  requested: string;
  id: string;
  label: string;
  shouldAttemptHighlight: boolean;
};

export function lightweightLanguage(language?: string): LightweightLanguage {
  const requested = String(language || '').trim().toLowerCase().replace(/^language-/, '');
  if (!requested || ['text', 'txt', 'plain', 'plaintext'].includes(requested)) {
    return { requested, id: 'plaintext', label: 'TEXT', shouldAttemptHighlight: false };
  }
  const id = commonAliases[requested] || requested;
  return {
    requested,
    id,
    label: commonAliases[requested] ? id.toUpperCase() : 'TEXT',
    shouldAttemptHighlight: true,
  };
}

export function extensionForLanguage(language?: string, resolvedLanguage?: string) {
  const id = resolvedLanguage || lightweightLanguage(language).id;
  return extensions[id] || 'txt';
}

export function utf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function shouldUseShiki(code: string) {
  return utf8ByteLength(code) <= SHIKI_MAX_BYTES;
}

export function applyTokenRecall<T>(
  previous: T[],
  update: { recall: number; stable: T[]; unstable: T[] },
) {
  const retained = update.recall > 0 ? previous.slice(0, -update.recall) : previous;
  return [...retained, ...update.stable, ...update.unstable];
}

export function supportsShikiRuntime(capabilities: { TransformStream?: unknown; WebAssembly?: unknown }) {
  return capabilities.TransformStream !== undefined && capabilities.WebAssembly !== undefined;
}

export async function importIfShikiSupported<T>(
  capabilities: { TransformStream?: unknown; WebAssembly?: unknown },
  importer: () => Promise<T>,
): Promise<T | null> {
  if (!supportsShikiRuntime(capabilities)) return null;
  try {
    return await importer();
  } catch {
    return null;
  }
}
