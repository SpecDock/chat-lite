/**
 * Normalize an attachment reference (raw id, /api/files/att_xxx URL, or full URL)
 * into the canonical `att_xxx` attachment id. Used by image_edit to find the
 * source image the user uploaded in the current conversation.
 */
export function normalizeAttachmentId(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'http://chat-lite.local');
    const match = url.pathname.match(/\/api\/files\/([^/?#]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {
    // fall through to regex fallback
  }
  const match = raw.match(/\/api\/files\/([^/?#\s]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : raw;
}