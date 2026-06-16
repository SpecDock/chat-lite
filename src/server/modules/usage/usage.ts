import { jsonError, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { getUsage } from './usage.service.js';

export function registerUsageRoutes(router: Router) {
  router.get('/api/usage', requireAuth, (ctx) => {
    try {
      ctx.sendJson(getUsage(auth(ctx).userId));
    } catch (error) {
      return jsonError(ctx, 500, error instanceof Error ? error.message : '获取消耗统计失败');
    }
  });
}
