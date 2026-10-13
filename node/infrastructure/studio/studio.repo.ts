import { db, now } from '../db/db.js';

export type StudioImageStatus = 'running' | 'succeeded' | 'failed';

export type StudioImageRow = {
  id: string;
  user_id: string;
  prompt: string;
  aspect_ratio: string;
  quality: string;
  style: string;
  width: number | null;
  height: number | null;
  status: StudioImageStatus;
  error: string | null;
  duration_ms: number | null;
  file_path: string | null;
  mime_type: string | null;
  created_at: string;
};

const STUDIO_COLUMNS = `id, user_id, prompt, aspect_ratio, quality, style, width, height, status, error, duration_ms, file_path, mime_type, created_at`;

const MAX_RUNNING = 4;

type InsertRunningInput = {
  id: string;
  userId: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  style: string;
};

const insertRunningTx = db.transaction((input: InsertRunningInput): StudioImageRow | null => {
  const running = db.prepare(`SELECT COUNT(*) AS n FROM studio_images WHERE user_id=? AND status='running'`).get(input.userId) as { n: number };
  if (running.n >= MAX_RUNNING) return null;
  const createdAt = now();
  db.prepare(`INSERT INTO studio_images (id, user_id, prompt, aspect_ratio, quality, style, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
    .run(input.id, input.userId, input.prompt, input.aspectRatio, input.quality, input.style, createdAt);
  const row = db.prepare(`SELECT ${STUDIO_COLUMNS} FROM studio_images WHERE id=? AND user_id=?`).get(input.id, input.userId) as StudioImageRow | undefined;
  if (!row) throw new Error('图片记录写入失败');
  return row;
});

export function failInterruptedRuns() {
  const result = db.prepare(`UPDATE studio_images SET status='failed', error=? WHERE status='running'`).run('生成已中断');
  return result.changes;
}

export function insertRunning(input: InsertRunningInput) {
  return insertRunningTx.immediate(input);
}

export function listByUser(userId: string) {
  return db.prepare(`SELECT ${STUDIO_COLUMNS} FROM studio_images WHERE user_id=? ORDER BY created_at DESC, id DESC`).all(userId) as StudioImageRow[];
}

export function findOwned(id: string, userId: string) {
  return db.prepare(`SELECT ${STUDIO_COLUMNS} FROM studio_images WHERE id=? AND user_id=?`).get(id, userId) as StudioImageRow | undefined;
}

const deleteOwnedTx = db.transaction((id: string, userId: string): StudioImageRow | undefined => {
  const row = db.prepare(`SELECT ${STUDIO_COLUMNS} FROM studio_images WHERE id=? AND user_id=?`).get(id, userId) as StudioImageRow | undefined;
  if (!row) return undefined;
  const result = db.prepare('DELETE FROM studio_images WHERE id=? AND user_id=?').run(id, userId);
  if (result.changes < 1) return undefined;
  return row;
});

export function deleteOwned(id: string, userId: string) {
  return deleteOwnedTx.immediate(id, userId);
}

export function markSucceeded(input: {
  id: string;
  userId: string;
  width: number;
  height: number;
  durationMs: number;
  filePath: string;
  mimeType: string;
}) {
  const result = db.prepare(`UPDATE studio_images
    SET status='succeeded', width=?, height=?, duration_ms=?, file_path=?, mime_type=?, error=NULL
    WHERE id=? AND user_id=? AND status='running'`)
    .run(input.width, input.height, input.durationMs, input.filePath, input.mimeType, input.id, input.userId);
  return result.changes > 0;
}

export function markFailed(id: string, userId: string, error: string, durationMs: number) {
  const result = db.prepare(`UPDATE studio_images
    SET status='failed', error=?, duration_ms=?
    WHERE id=? AND user_id=? AND status='running'`)
    .run(error, durationMs, id, userId);
  return result.changes > 0;
}

export type StudioReferenceRow = {
  id: string;
  studio_image_id: string;
  user_id: string;
  file_path: string;
  mime_type: string;
  sort_order: number;
};

const REFERENCE_COLUMNS = `id, studio_image_id, user_id, file_path, mime_type, sort_order`;

export function insertReferences(rows: StudioReferenceRow[]) {
  if (!rows.length) return;
  const statement = db.prepare(`INSERT INTO studio_image_references (id, studio_image_id, user_id, file_path, mime_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction((items: StudioReferenceRow[]) => {
    for (const item of items) statement.run(item.id, item.studio_image_id, item.user_id, item.file_path, item.mime_type, item.sort_order);
  }).immediate(rows);
}

export function listReferencesByUser(userId: string) {
  return db.prepare(`SELECT ${REFERENCE_COLUMNS} FROM studio_image_references WHERE user_id=? ORDER BY sort_order ASC, id ASC`).all(userId) as StudioReferenceRow[];
}

export function listReferences(studioImageId: string, userId: string) {
  return db.prepare(`SELECT ${REFERENCE_COLUMNS} FROM studio_image_references WHERE studio_image_id=? AND user_id=? ORDER BY sort_order ASC, id ASC`).all(studioImageId, userId) as StudioReferenceRow[];
}

export function findReference(studioImageId: string, referenceId: string, userId: string) {
  return db.prepare(`SELECT ${REFERENCE_COLUMNS} FROM studio_image_references WHERE id=? AND studio_image_id=? AND user_id=?`).get(referenceId, studioImageId, userId) as StudioReferenceRow | undefined;
}
