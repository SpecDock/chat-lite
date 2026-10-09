import 'dotenv/config';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { registerAuthRoutes } from './interfaces/http/auth.js';
import { registerConversationRoutes, registerChatRoutes } from './interfaces/http/chat.js';
import { registerUploadRoutes } from './interfaces/http/upload.js';
import { registerFileRoutes } from './interfaces/http/files.js';
import { registerImageRoutes } from './interfaces/http/images.js';
import { registerStudioRoutes } from './interfaces/http/studio.js';
import { registerProfileRoutes } from './interfaces/http/profile.js';
import { registerUsageRoutes } from './interfaces/http/usage.js';
import { registerSearchRoutes } from './interfaces/http/search.js';
import { registerEventRoutes } from './interfaces/http/events.js';
import { registerWorkspaceRoutes } from './interfaces/http/workspace.js';
import { cors, jsonError, RequestContext, Router, serveStaticOrSpa } from './interfaces/http/http.js';
import './infrastructure/db/db.js';

const router = new Router();
router.use('/api', cors(process.env.APP_ORIGIN || 'http://localhost:5173'));

registerAuthRoutes(router);
registerConversationRoutes(router);
registerChatRoutes(router);
registerUploadRoutes(router);
registerFileRoutes(router);
registerImageRoutes(router);
registerStudioRoutes(router);
registerProfileRoutes(router);
registerUsageRoutes(router);
registerSearchRoutes(router);
registerEventRoutes(router);
registerWorkspaceRoutes(router);

router.get('/api/health', (ctx) => ctx.sendJson({ ok: true }));

const distDir = join(process.cwd(), 'dist');
const server = createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
  try {
    if ((req.url || '/').startsWith('/api/')) return await router.handle(req, res);
    if (process.env.NODE_ENV === 'production') return await serveStaticOrSpa(new RequestContext(req, res), distDir);
    return jsonError(new RequestContext(req, res), 404, 'Not found');
  } catch (error) {
    console.error('[http] request failed', error instanceof Error ? error.message : error);
    if (!res.headersSent) return jsonError(new RequestContext(req, res), 500, '服务器内部错误');
    if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Chat Lite listening on http://localhost:${port}`));
