import { jsonError, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { generateImageForUser } from './image-generation.service.js';
import { findUserAttachmentPath } from './image.repo.js';
import { understandImageWithMiniMax } from './mcp.adapter.js';

export function registerImageRoutes(router: Router) {
  router.post('/api/images/understand', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const attachmentId = String(body.attachmentId || '');
    const conversationId = String(body.conversationId || '').trim();
    const prompt = String(body.prompt || '请描述这张图片');
    if (!conversationId) return jsonError(ctx, 400, 'conversationId不能为空');
    const att = findUserAttachmentPath(attachmentId, auth(ctx).userId, conversationId);
    if (!att) return jsonError(ctx, 404, '图片不存在');
    try { ctx.sendJson({ result: await understandImageWithMiniMax(att.file_path, prompt) }); }
    catch (e) { return jsonError(ctx, 501, e instanceof Error ? e.message : '图片理解未配置'); }
  });

  router.post('/api/images/generate', requireAuth, async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const prompt = String(body.prompt || '').trim();
    const conversationId = String(body.conversationId || '').trim();
    if (!prompt) return jsonError(ctx, 400, '提示词不能为空');
    if (!conversationId) return jsonError(ctx, 400, 'conversationId不能为空');
    try {
      const result = await generateImageForUser({
        userId: auth(ctx).userId,
        prompt,
        conversationId,
        sourceAttachmentId: String(body.sourceAttachmentId || body.attachmentId || '') || undefined
      });
      ctx.sendJson({ generationId: result.generationId, attachment: result.attachment, markdown: result.markdown });
    } catch (error) {
      return jsonError(ctx, (error as any).status || 502, error instanceof Error ? error.message : '图片生成失败');
    }
  });
}
