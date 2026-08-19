/**
 * Helpers for parsing the `/api/chat` request body and assembling the user
 * message that gets persisted + indexed for RAG. All routing / plan-building
 * helpers were removed when the main path moved to AgentLoop; only the
 * request/serialization helpers are kept here.
 */

import { answerHistoryLimit } from './history-limits.js';
import { selectModelVisibleHistory } from './message-visibility.js';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { newId } from '../../core/security.js';
import { row } from '../../core/db.js';
import { conversationInputDir } from '../workspace/workspace.service.js';
import {
  deleteUnlinkedAttachments,
  insertClonedAttachment,
  listChatHistoryPage,
  type CloneAttachmentRow
} from './chat.repo.js';

export type ClonedAttachment = Pick<CloneAttachmentRow, 'id' | 'file_path'>;

export function loadModelHistory(conversationId: string, userId: string, excludedMessageIds: string[] = []) {
  const limit = answerHistoryLimit();
  const pageSize = 50;
  const newest = [];
  const excluded = new Set(excludedMessageIds);
  let offset = 0;
  while (newest.length < limit) {
    const page = listChatHistoryPage(conversationId, userId, pageSize, offset);
    for (const message of page) {
      if (excluded.has(message.id)) continue;
      if (selectModelVisibleHistory([message], 1).length) newest.push(message);
      if (newest.length >= limit) break;
    }
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return newest.slice(0, limit).reverse();
}

export function userMessageContent(input: string, attachmentIds: string[]) {
  if (!attachmentIds.length) return input;
  const attachmentMarkdown = attachmentIds.map(id => {
    const attachment = row<{ mime_type: string; original_name: string | null }>('SELECT mime_type,original_name FROM attachments WHERE id=?', id);
    if (attachment?.mime_type.startsWith('image/')) return `![image](/api/files/${id})`;
    const label = String(attachment?.original_name || '表格附件').replace(/[\[\]()`]/g, '').slice(0, 120) || '表格附件';
    return `[${label}](/api/files/${id})`;
  }).join('\n');
  return input ? `${input}\n\n${attachmentMarkdown}` : attachmentMarkdown;
}

export function attachmentIdsFromContent(content: string) {
  const ids = new Set<string>();
  const pattern = /!?\[[^\]]*\]\(\/api\/files\/([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(pattern)) {
    try {
      ids.add(decodeURIComponent(match[1]));
    } catch {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

export function stripUserImageContent(content: string) {
  return content
    .replace(/!?\[[^\]]*\]\(\/api\/files\/[^\s)]+(?:\s+["'][^"']*["'])?\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function cloneUserAttachments(attachments: CloneAttachmentRow[], userId: string, conversationId: string) {
  if (!attachments.length) return [];
  const userDirectory = conversationInputDir(conversationId);
  await mkdir(userDirectory, { recursive: true });
  const clones: ClonedAttachment[] = [];
  try {
    for (const source of attachments) {
      const id = newId('att');
      const suffix = extname(source.file_path) || extname(source.original_name || '') || '.img';
      const filePath = join(userDirectory, `${id}${suffix}`);
      await copyFile(source.file_path, filePath);
      try {
        insertClonedAttachment({
          id,
          userId,
          conversationId,
          originalName: source.original_name,
          filePath,
          publicPath: `/api/files/${id}`,
          mimeType: source.mime_type,
          size: source.size
        });
      } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
      }
      clones.push({ id, file_path: filePath });
    }
    return clones;
  } catch (error) {
    deleteUnlinkedAttachments(clones.map(clone => clone.id), userId);
    await Promise.allSettled(clones.map(clone => unlink(clone.file_path)));
    throw error;
  }
}

export async function discardClonedAttachments(attachments: ClonedAttachment[], userId: string) {
  deleteUnlinkedAttachments(attachments.map(attachment => attachment.id), userId);
  await Promise.allSettled(attachments.map(attachment => unlink(attachment.file_path)));
}

export async function removeAttachmentFiles(attachments: Array<{ file_path: string }>) {
  await Promise.allSettled(attachments.map(attachment => unlink(attachment.file_path)));
}

export function parseChatRequest(body: unknown) {
  const source = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const content = String(source.content || source.message || '').trim();
  const conversationId = String(source.conversationId || '').trim();
  const attachmentIds = Array.isArray(source.attachmentIds) ? source.attachmentIds.map(String).filter(Boolean).slice(0, 4) : [];
  const editUserMessageId = String(source.editUserMessageId || '').trim();
  const userInput = content || '';
  return { content, conversationId, attachmentIds, editUserMessageId, userInput };
}
