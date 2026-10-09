import { mkdirSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { all, dataDir, db, row } from '../../infrastructure/db/db.js';
import { conversationWorkspaceDir, isSafeWorkspaceId, isWithinDirectory, workspaceBucketDir, workspaceRoot, type WorkspaceBucket } from '../../infrastructure/files/workspace-paths.js';
import type { WorkspaceFileDTO, WorkspaceFilesDTO } from '../../../shared/types.js';

type AttachmentWorkspaceRow = {
  id: string;
  original_name: string | null;
  mime_type: string;
  size: number;
  created_at: string;
  file_path: string;
};

const fallbackMime: Record<string, string> = {
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
};

function mimeFor(fileName: string) {
  return fallbackMime[extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function assertConversationId(conversationId: string) {
  if (!isSafeWorkspaceId(conversationId)) throw Object.assign(new Error('会话不存在'), { status: 404 });
}

export function ensureConversationWorkspace(conversationId: string) {
  assertConversationId(conversationId);
  const directory = conversationWorkspaceDir(dataDir, conversationId);
  mkdirSync(directory, { recursive: true });
  mkdirSync(workspaceBucketDir(dataDir, conversationId, 'input'), { recursive: true });
  mkdirSync(workspaceBucketDir(dataDir, conversationId, 'output'), { recursive: true });
}

export async function removeConversationWorkspace(conversationId: string) {
  if (!isSafeWorkspaceId(conversationId)) return;
  try {
    await rm(conversationWorkspaceDir(dataDir, conversationId), { recursive: true, force: true });
  } catch (error) {
    console.warn('[workspace] remove failed', { conversationId, error: error instanceof Error ? error.message : String(error) });
  }
}

export function conversationInputDir(conversationId: string) {
  assertConversationId(conversationId);
  return workspaceBucketDir(dataDir, conversationId, 'input');
}

export function conversationOutputDir(conversationId: string) {
  assertConversationId(conversationId);
  return workspaceBucketDir(dataDir, conversationId, 'output');
}

export function isWorkspaceAttachment(filePath: string, conversationId: string, bucket: WorkspaceBucket) {
  if (!isSafeWorkspaceId(conversationId)) return false;
  return isWithinDirectory(workspaceBucketDir(dataDir, conversationId, bucket), filePath);
}

function workspaceUrl(conversationId: string, bucket: WorkspaceBucket, storageName: string, attachmentId?: string) {
  if (attachmentId) return `/api/files/${encodeURIComponent(attachmentId)}`;
  return `/api/conversations/${encodeURIComponent(conversationId)}/workspace/files/${bucket}/${encodeURIComponent(storageName)}`;
}

function listAttachmentRows(userId: string, conversationId: string) {
  return all<AttachmentWorkspaceRow>(`SELECT id,original_name,mime_type,size,created_at,file_path
    FROM attachments WHERE user_id=? AND conversation_id=?`, userId, conversationId);
}

export async function listWorkspaceFiles(userId: string, conversationId: string): Promise<WorkspaceFilesDTO | undefined> {
  if (!row<{ id: string }>('SELECT id FROM conversations WHERE id=? AND user_id=?', conversationId, userId)) return undefined;
  ensureConversationWorkspace(conversationId);
  const attachmentByPath = new Map(listAttachmentRows(userId, conversationId).map(attachment => [resolve(attachment.file_path), attachment]));
  const result: WorkspaceFilesDTO = { conversationId, input: [], output: [] };

  for (const bucket of ['input', 'output'] as const) {
    const directory = workspaceBucketDir(dataDir, conversationId, bucket);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files: WorkspaceFileDTO[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(directory, entry.name);
      const fileStat = await lstat(filePath).catch(() => undefined);
      if (!fileStat?.isFile()) continue;
      const attachment = attachmentByPath.get(resolve(filePath));
      if (!attachment) continue;
      const mimeType = attachment?.mime_type || mimeFor(entry.name);
      const url = workspaceUrl(conversationId, bucket, entry.name, attachment?.id);
      files.push({
        name: attachment?.original_name || entry.name,
        mimeType,
        size: attachment?.size ?? fileStat.size,
        createdAt: attachment?.created_at || fileStat.birthtime.toISOString(),
        bucket,
        attachmentId: attachment?.id,
        url,
        previewUrl: mimeType.startsWith('image/') ? url : undefined,
        downloadUrl: `${url}${url.includes('?') ? '&' : '?'}download=1`
      });
    }
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    result[bucket] = files;
  }
  return result;
}

export async function resolveWorkspaceFile(userId: string, conversationId: string, bucket: string, fileName: string) {
  if (!isSafeWorkspaceId(conversationId)) return undefined;
  if (!row<{ id: string }>('SELECT id FROM conversations WHERE id=? AND user_id=?', conversationId, userId)) return undefined;
  if (bucket !== 'input' && bucket !== 'output') return undefined;
  if (!fileName || basename(fileName) !== fileName || fileName.includes('\\') || fileName.includes('\0')) return undefined;
  const directory = workspaceBucketDir(dataDir, conversationId, bucket);
  const filePath = resolve(join(directory, fileName));
  if (!isWithinDirectory(directory, filePath)) return undefined;
  const fileStat = await lstat(filePath).catch(() => undefined);
  if (!fileStat?.isFile()) return undefined;
  const attachment = row<AttachmentWorkspaceRow>(`SELECT id,original_name,mime_type,size,created_at,file_path
    FROM attachments WHERE id IS NOT NULL AND user_id=? AND conversation_id=? AND file_path=?`, userId, conversationId, filePath);
  if (!attachment) return undefined;
  return {
    filePath,
    fileName: attachment?.original_name || fileName,
    mimeType: attachment?.mime_type || mimeFor(fileName),
    size: attachment?.size ?? fileStat.size
  };
}

export function workspaceRootDirectory() {
  return workspaceRoot(dataDir);
}
