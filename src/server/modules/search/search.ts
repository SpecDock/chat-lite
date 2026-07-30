import type { MessageSearchResponse } from '../../../shared/types.js';
import { jsonError, type Router } from '../../core/http.js';
import { auth, requireAuth } from '../../core/security.js';
import { initializeMessageSearch, searchMessages } from './search.repo.js';

export function registerSearchRoutes(router: Router) {
  initializeMessageSearch();

  router.get('/api/search/messages', requireAuth, (ctx) => {
    const query = (ctx.url.searchParams.get('q') || '').trim();
    if (Array.from(query).length > 200) return jsonError(ctx, 400, '搜索内容不能超过 200 个字符');

    const rawOffset = ctx.url.searchParams.get('offset');
    const offset = rawOffset === null || rawOffset === '' ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) return jsonError(ctx, 400, 'offset 必须是非负整数');

    if (!query) {
      const response: MessageSearchResponse = { items: [], hasMore: false, nextOffset: null };
      return ctx.sendJson(response);
    }
    ctx.sendJson(searchMessages(auth(ctx).userId, query, offset) satisfies MessageSearchResponse);
  });
}
