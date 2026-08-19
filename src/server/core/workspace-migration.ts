import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { conversationWorkspaceDir, isSafeWorkspaceId, isWithinDirectory, workspaceBucketDir, workspaceRoot, type WorkspaceBucket } from './workspace-paths.js';

type SqliteLike = { prepare: (sql: string) => any };

type AttachmentRow = {
  id: string;
  conversation_id: string | null;
  file_path: string;
  original_name: string | null;
};

function moveFile(source: string, destination: string) {
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(source, destination);
    unlinkSync(source);
  }
}

function fileHash(filePath: string) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function logMigration(event: string, details: Record<string, unknown>) {
  console.warn('[workspace-migration]', { event, ...details });
}

export function migrateAttachmentWorkspaces(database: SqliteLike, dataDir: string) {
  const root = workspaceRoot(dataDir);
  mkdirSync(root, { recursive: true });

  const conversations = database.prepare('SELECT id FROM conversations').all() as Array<{ id: string }>;
  for (const conversation of conversations) {
    if (!isSafeWorkspaceId(conversation.id)) {
      logMigration('invalid-conversation-id', { conversationId: conversation.id });
      continue;
    }
    mkdirSync(conversationWorkspaceDir(dataDir, conversation.id), { recursive: true });
    mkdirSync(workspaceBucketDir(dataDir, conversation.id, 'input'), { recursive: true });
    mkdirSync(workspaceBucketDir(dataDir, conversation.id, 'output'), { recursive: true });
  }

  const attachments = database.prepare(`
    SELECT id,conversation_id,file_path,original_name
    FROM attachments
    WHERE conversation_id IS NOT NULL
  `).all() as AttachmentRow[];

  for (const attachment of attachments) {
    const conversationId = attachment.conversation_id || '';
    if (!isSafeWorkspaceId(conversationId)) {
      logMigration('skip-invalid-conversation', { attachmentId: attachment.id, conversationId });
      continue;
    }

    const source = resolve(attachment.file_path);
    const generated = isWithinDirectory(workspaceBucketDir(dataDir, conversationId, 'output'), source) || database.prepare(`
      SELECT 1 FROM image_generations
      WHERE result_attachment_id=? AND status='completed'
      LIMIT 1
    `).get(attachment.id);
    const bucket: WorkspaceBucket = generated ? 'output' : 'input';
    const destinationDir = workspaceBucketDir(dataDir, conversationId, bucket);
    mkdirSync(destinationDir, { recursive: true });

    const extension = extname(attachment.file_path) || extname(attachment.original_name || '') || '.img';
    const destination = resolve(join(destinationDir, `${attachment.id}${extension}`));
    try {
      if (source === destination) continue;

      const sourceExists = existsSync(source);
      const destinationExists = existsSync(destination);
      if (!sourceExists && !destinationExists) {
        logMigration('missing-file', { attachmentId: attachment.id, conversationId, source });
        continue;
      }

      if (sourceExists && lstatSync(source).isSymbolicLink()) {
        logMigration('skip-symlink', { attachmentId: attachment.id, source });
        continue;
      }

      if (destinationExists && sourceExists) {
        const sourceStat = lstatSync(source);
        const destinationStat = lstatSync(destination);
        if (!sourceStat.isFile() || !destinationStat.isFile() || sourceStat.size !== destinationStat.size || fileHash(source) !== fileHash(destination)) {
          logMigration('destination-conflict', { attachmentId: attachment.id, source, destination });
          continue;
        }
        unlinkSync(source);
      } else if (sourceExists) {
        moveFile(source, destination);
      }

      try {
        database.prepare('UPDATE attachments SET file_path=? WHERE id=?').run(destination, attachment.id);
      } catch (error) {
        if (existsSync(destination) && !existsSync(source)) {
          mkdirSync(dirname(source), { recursive: true });
          moveFile(destination, source);
        }
        throw error;
      }
    } catch (error) {
      logMigration('file-failed', {
        attachmentId: attachment.id,
        conversationId,
        bucket,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
