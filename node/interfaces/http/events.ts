import type { ServerResponse } from 'node:http';
import { type Router } from './http.js';
import { auth, requireAuth } from '../../infrastructure/auth/security.js';

type EventPayload = Record<string, unknown>;

const clients = new Map<string, Set<ServerResponse>>();

function writeEvent(res: ServerResponse, event: string, data: EventPayload = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function emitToUser(userId: string, event: string, data: EventPayload = {}) {
  const set = clients.get(userId);
  if (!set?.size) return;
  for (const res of set) writeEvent(res, event, data);
}

export function registerEventRoutes(router: Router) {
  router.get('/api/events', requireAuth, (ctx) => {
    const userId = auth(ctx).userId;
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });

    let set = clients.get(userId);
    if (!set) {
      set = new Set();
      clients.set(userId, set);
    }
    set.add(ctx.res);
    writeEvent(ctx.res, 'connected', { ok: true });

    const heartbeat = setInterval(() => {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.write(': ping\n\n');
    }, 25_000);

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        clearInterval(heartbeat);
        set?.delete(ctx.res);
        if (set && set.size === 0) clients.delete(userId);
        resolve();
      };
      ctx.req.on('close', cleanup);
      ctx.res.on('close', cleanup);
    });
  });
}
