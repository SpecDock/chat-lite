import { jsonError, type Router } from './http.js';
import { auth, requireAuth } from '../../infrastructure/auth/security.js';
import { getUsage } from '../../application/usage/usage.service.js';

export function registerUsageRoutes(router: Router) {
  router.get('/api/usage', requireAuth, (ctx) => {
    try {
      ctx.sendJson(getUsage(auth(ctx).userId));
    } catch (error) {
      return jsonError(ctx, 500, error instanceof Error ? error.message : '获取消耗统计失败');
    }
  });
}
