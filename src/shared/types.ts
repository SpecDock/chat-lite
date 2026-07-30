export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'streaming' | 'completed' | 'interrupted' | 'error';

export interface UserDTO { id: string; email: string; created_at?: string; avatar_url?: string | null }
export interface ConversationDTO { id: string; title: string; pinned_at: string | null; created_at: string; updated_at: string }
export interface AttachmentDTO { id: string; original_name: string; public_path: string; mime_type: string; size: number; created_at: string }
export interface MessageDTO { id: string; conversation_id: string; role: Role; content: string; status: MessageStatus; created_at: string; attachments?: AttachmentDTO[] }
export interface SearchMessageResultDTO { messageId: string; conversationId: string; conversationTitle: string; role: Extract<Role, 'user' | 'assistant'>; snippet: string; createdAt: string }
export interface SearchMessagesResponseDTO { items: SearchMessageResultDTO[]; hasMore: boolean; nextOffset: number | null }
export type MessageSearchItemDTO = SearchMessageResultDTO;
export type MessageSearchResponse = SearchMessagesResponseDTO;
export interface UsageDayDTO { date: string; label: string; value: number }
export interface TokenUsageDayDTO {
  date: string;
  label: string;
  inputValue: number;
  outputValue: number;
  cachedValue: number;
  cacheRate: number | null;
  value: number;
}
export interface UsageDTO {
  token: {
    inputTotal: number;
    outputTotal: number;
    cachedTotal: number;
    days: TokenUsageDayDTO[];
    total: number;
  };
  image: { total: number; days: UsageDayDTO[] };
}
