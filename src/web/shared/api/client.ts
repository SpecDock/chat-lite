import type { AttachmentDTO, ConversationDTO, MessageDTO, SearchMessagesResponseDTO, UsageDTO, UserDTO, WorkspaceFilesDTO } from '../../../shared/types';

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export class StudioApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'StudioApiError';
    this.status = status;
  }
}

function studioErrorMessage(data: unknown, status: number) {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) return data.error;
  return `HTTP ${status}`;
}

async function parseStudio(res: Response): Promise<unknown> {
  const data: unknown = await res.json().catch(() => ({}));
  if (res.status === 409) throw new StudioApiError('当前已有 4 张图片正在生成，请等完成后再试。', 409);
  if (!res.ok) throw new StudioApiError(studioErrorMessage(data, res.status), res.status);
  return data;
}

export function buildSearchMessagesUrl(q: string, offset: number) {
  const params = new URLSearchParams({ q, offset: String(offset), limit: '30' });
  return `/api/search/messages?${params.toString()}`;
}

export const api = {
  me: () => fetch('/api/auth/me', { credentials: 'include' }).then(r => parse<{ user: UserDTO }>(r)),
  sendCode: (email: string, inviteCode: string) => fetch('/api/auth/send-code', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, inviteCode }) }).then(r => parse<{ ok: boolean }>(r)),
  register: (body: { email: string; password: string; code: string; inviteCode: string }) => fetch('/api/auth/register', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => parse<{ user: UserDTO }>(r)),
  login: (email: string, password: string) => fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(r => parse<{ user: UserDTO }>(r)),
  passwordCaptcha: () => fetch('/api/auth/password-captcha', { credentials: 'include' }).then(r => parse<{ challengeId: string; expression: string }>(r)),
  sendPasswordResetCode: (body: { email: string; challengeId: string; captchaAnswer: number }) => fetch('/api/auth/password/send-code', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => parse<{ ok: boolean }>(r)),
  resetPassword: (body: { email: string; code: string; newPassword: string; confirmPassword: string }) => fetch('/api/auth/password/reset', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => parse<{ ok: boolean }>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(r => parse<{ ok: boolean }>(r)),
  updateAvatar: (file: File) => { const fd = new FormData(); fd.append('avatar', file); return fetch('/api/profile/avatar', { method: 'POST', credentials: 'include', body: fd }).then(r => parse<{ ok: boolean; user: UserDTO }>(r)); },
  sendPasswordChangeCode: () => fetch('/api/profile/password/send-code', { method: 'POST', credentials: 'include' }).then(r => parse<{ ok: boolean }>(r)),
  changePassword: (body: { code: string; newPassword: string; confirmPassword: string }) => fetch('/api/profile/password', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => parse<{ ok: boolean }>(r)),
  listConversations: () => fetch('/api/conversations', { credentials: 'include' }).then(r => parse<{ conversations: ConversationDTO[] }>(r)),
  createConversation: (title = '新会话') => fetch('/api/conversations', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).then(r => parse<{ conversation: ConversationDTO }>(r)),
  pinConversation: (id: string, pinned: boolean) => fetch(`/api/conversations/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) }).then(r => parse<{ conversation: ConversationDTO }>(r)),
  renameConversation: (id: string, title: string) => fetch(`/api/conversations/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).then(r => parse<{ conversation: ConversationDTO }>(r)),
  deleteConversation: (id: string) => fetch(`/api/conversations/${id}`, { method: 'DELETE', credentials: 'include' }).then(r => parse<{ ok: boolean }>(r)),
  deleteMessage: (conversationId: string, userMessageId: string) => fetch(`/api/conversations/${conversationId}/messages/${userMessageId}`, { method: 'DELETE', credentials: 'include' }).then(r => parse<{ ok: boolean; conversationDeleted: boolean }>(r)),
  messages: (id: string) => fetch(`/api/conversations/${id}/messages`, { credentials: 'include' }).then(r => parse<{ messages: MessageDTO[] }>(r)),
  workspace: (id: string) => fetch(`/api/conversations/${id}/workspace`, { credentials: 'include' }).then(r => parse<{ workspace: WorkspaceFilesDTO }>(r)),
  searchMessages: (q: string, offset: number, signal?: AbortSignal) => fetch(buildSearchMessagesUrl(q, offset), { credentials: 'include', signal }).then(r => parse<SearchMessagesResponseDTO>(r)),
  upload: (file: File, conversationId?: string) => { const fd = new FormData(); fd.append('file', file); if (conversationId) fd.append('conversationId', conversationId); return fetch('/api/upload', { method: 'POST', credentials: 'include', body: fd }).then(r => parse<{ attachment: AttachmentDTO }>(r)); },
  usage: () => fetch('/api/usage', { credentials: 'include' }).then(r => parse<UsageDTO>(r)),
  listStudioImages: () => fetch('/api/studio/images', { credentials: 'include' }).then(parseStudio),
  createStudioImage: (input: { prompt: string; aspectRatio: string; quality: string; style: string; images: File[] }) => {
    const body = new FormData();
    body.append('prompt', input.prompt);
    body.append('aspectRatio', input.aspectRatio);
    body.append('quality', input.quality);
    body.append('style', input.style);
    for (const image of input.images) body.append('images', image);
    return fetch('/api/studio/images', { method: 'POST', credentials: 'include', body }).then(parseStudio);
  },
  deleteStudioImage: (id: string) => fetch(`/api/studio/images/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).then(parseStudio)
};

export type ChatStreamData = {
  conversationId?: string;
  userMessageId?: string;
  messageId?: string;
  mode?: 'replace' | 'append';
  text?: string;
  language?: string;
  code?: string;
  output?: string;
  error?: string;
  ok?: boolean;
};

export async function streamChat(conversationId: string | undefined, message: string, attachmentIds: string[], onEvent: (event: string, data: ChatStreamData) => void, signal?: AbortSignal, editUserMessageId?: string) {
  const body = { conversationId, content: message, attachmentIds, ...(editUserMessageId ? { editUserMessageId } : {}) };
  const res = await fetch('/api/chat', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || '发送失败');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const event = part.match(/^event: (.+)$/m)?.[1] || 'message';
      const data = JSON.parse(part.match(/^data: (.+)$/m)?.[1] || '{}');
      onEvent(event, data);
    }
  }
}
