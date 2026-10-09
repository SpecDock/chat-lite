import { jsonError, type Router } from './http.js';
import { auth, requireAuth } from '../../infrastructure/auth/security.js';
import { generateImageForUser } from '../../infrastructure/images/image-generation.service.js';

export function registerImageRoutes(router: Router) {
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
