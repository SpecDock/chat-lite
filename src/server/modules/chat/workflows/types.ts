import type { MessageDTO } from '../../../../shared/types.js';

export type WorkflowInput = {
  userId: string;
  conversationId: string;
  input: string;
  history: Pick<MessageDTO, 'role' | 'content'>[];
  attachmentIds: string[];
  sourceAttachmentId?: string;
  prompts?: string[];
  signal?: AbortSignal;
};

export type WorkflowEvent = { type: 'think' | 'delta'; text: string } | { type: 'usage'; usage: { model?: string | null; promptTokens?: number; completionTokens?: number; totalTokens?: number } };
