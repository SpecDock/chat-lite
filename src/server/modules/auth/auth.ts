import { deleteCookie, setCookie, jsonError, type Router } from '../../core/http.js';
import { cookieName, rateLimit, requireAuth, auth } from '../../core/security.js';
import { AuthError, loginUser, logoutSession, normalizeEmail, registerUser, sendRegisterCode, userDto } from './auth.service.js';

function sendAuthSession(ctx: import('../../core/http.js').RequestContext, result: Awaited<ReturnType<typeof loginUser>>) {
  setCookie(ctx, result.cookie.name, result.cookie.value, result.cookie.options);
  ctx.sendJson({ user: result.user });
}

function handleAuthError(ctx: import('../../core/http.js').RequestContext, error: unknown) {
  return jsonError(ctx, error instanceof AuthError ? error.status : 400, error instanceof Error ? error.message : '请求失败');
}

export function registerAuthRoutes(router: Router) {
  router.post('/api/auth/send-code', rateLimit(5, 10 * 60_000), async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const inviteCode = String(body.inviteCode || '').trim();
    try {
      await sendRegisterCode(email, inviteCode);
    } catch (error) {
      return handleAuthError(ctx, error);
    }
    ctx.sendJson({ ok: true });
  });

  router.post('/api/auth/register', rateLimit(10, 10 * 60_000), async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const code = String(body.code || '').trim();
    const inviteCode = String(body.inviteCode || '').trim();
    try { sendAuthSession(ctx, await registerUser(email, password, code, inviteCode)); }
    catch (error) { return handleAuthError(ctx, error); }
  });

  router.post('/api/auth/login', rateLimit(20, 10 * 60_000), async (ctx) => {
    const body = await ctx.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    try { sendAuthSession(ctx, await loginUser(email, password)); }
    catch (error) { return handleAuthError(ctx, error); }
  });

  router.post('/api/auth/logout', requireAuth, (ctx) => {
    logoutSession(auth(ctx).sessionId);
    deleteCookie(ctx, cookieName, '/');
    ctx.sendJson({ ok: true });
  });

  router.get('/api/auth/me', requireAuth, (ctx) => ctx.sendJson({ user: userDto(auth(ctx).userId, auth(ctx).email) }));
}
