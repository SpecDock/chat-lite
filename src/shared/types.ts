export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'streaming' | 'completed' | 'interrupted' | 'error';

export interface UserDTO { id: string; email: string; created_at?: string; avatar_url?: string | null }
export interface ConversationDTO { id: string; title: string; created_at: string; updated_at: string }
export interface AttachmentDTO { id: string; original_name: string; public_path: string; mime_type: string; size: number; created_at: string }
export interface MessageDTO { id: string; conversation_id: string; role: Role; content: string; status: MessageStatus; created_at: string; attachments?: AttachmentDTO[] }
export interface UsageDayDTO { date: string; label: string; value: number }
export interface TokenUsageDayDTO extends UsageDayDTO { cachedValue: number; cacheRate: number | null }
export interface UsageDTO { token: { total: number; cachedTotal: number; days: TokenUsageDayDTO[] }; image: { total: number; days: UsageDayDTO[] } }
