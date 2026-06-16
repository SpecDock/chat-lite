import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Next = () => Promise<void>;
export type Handler = (ctx: RequestContext, next?: Next) => unknown | Promise<unknown>;
export type Middleware = Handler;

type Route = { method: string; pattern: RegExp; names: string[]; handlers: Handler[] };

const statusText: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed',
  413: 'Payload Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error'
};

export class RequestContext {
  params: Record<string, string> = {};
  state = new Map<string, unknown>();
  url: URL;
  private body?: Buffer;

  constructor(public req: IncomingMessage, public res: ServerResponse) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || 'localhost';
    this.url = new URL(req.url || '/', `${proto}://${host}`);
  }

  get method() { return (this.req.method || 'GET').toUpperCase(); }
  get path() { return this.url.pathname; }
  header(name: string) {
    const value = this.req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
  set<T>(key: string, value: T) { this.state.set(key, value); }
  get<T>(key: string) { return this.state.get(key) as T; }

  async readBody(limitBytes = 1024 * 1024) {
    if (this.body) return this.body;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limitBytes) throw Object.assign(new Error('请求体过大'), { status: 413 });
      chunks.push(buf);
    }
    this.body = Buffer.concat(chunks);
    return this.body;
  }

  async json<T = any>() {
    const raw = (await this.readBody()).toString('utf8');
    if (!raw) return {} as T;
    return JSON.parse(raw) as T;
  }

  sendJson(data: unknown, status = 200) {
    if (this.res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(data));
    this.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    this.res.end(body);
  }

  sendText(text: string, status = 200, contentType = 'text/plain; charset=utf-8') {
    if (this.res.writableEnded) return;
    this.res.writeHead(status, { 'content-type': contentType });
    this.res.end(text);
  }
}

function compile(path: string) {
  const names: string[] = [];
  const source = path.split('/').filter(Boolean).map(part => {
    if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { pattern: new RegExp(`^/${source}/?$`), names };
}

export class Router {
  private routes: Route[] = [];
  private middlewares: { prefix: string; middleware: Middleware }[] = [];

  use(prefix: string, middleware: Middleware) { this.middlewares.push({ prefix, middleware }); }
  get(path: string, ...handlers: Handler[]) { this.add('GET', path, handlers); }
  post(path: string, ...handlers: Handler[]) { this.add('POST', path, handlers); }
  delete(path: string, ...handlers: Handler[]) { this.add('DELETE', path, handlers); }

  private add(method: string, path: string, handlers: Handler[]) {
    const { pattern, names } = compile(path);
    this.routes.push({ method, pattern, names, handlers });
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const ctx = new RequestContext(req, res);
    try {
      const matchingMiddlewares = this.middlewares.filter(m => ctx.path === m.prefix || ctx.path.startsWith(`${m.prefix}/`)).map(m => m.middleware);
      if (ctx.method === 'OPTIONS' && matchingMiddlewares.length) {
        let mi = -1;
        const run = async (idx: number): Promise<void> => {
          if (idx <= mi) throw new Error('next() called multiple times');
          mi = idx;
          const fn = matchingMiddlewares[idx];
          if (fn && !res.writableEnded) await fn(ctx, () => run(idx + 1));
        };
        await run(0);
        if (!res.writableEnded) res.end();
        return;
      }
      const route = this.routes.find(r => r.method === ctx.method && r.pattern.test(ctx.path));
      if (!route) return jsonError(ctx, 404, 'Not found');
      const match = ctx.path.match(route.pattern);
      route.names.forEach((name, i) => { ctx.params[name] = decodeURIComponent(match?.[i + 1] || ''); });
      const stack: (Handler | Middleware)[] = [...matchingMiddlewares, ...route.handlers];
      let i = -1;
      const dispatch = async (idx: number): Promise<void> => {
        if (idx <= i) throw new Error('next() called multiple times');
        i = idx;
        const fn = stack[idx];
        if (!fn || res.writableEnded) return;
        if (idx < matchingMiddlewares.length || fn.length >= 2) await (fn as Middleware)(ctx, () => dispatch(idx + 1));
        else { await (fn as Handler)(ctx); if (!res.writableEnded) await dispatch(idx + 1); }
      };
      await dispatch(0);
      if (!res.writableEnded) res.end();
    } catch (error) {
      console.error(error);
      if (!res.writableEnded) jsonError(ctx, (error as any).status || 500, error instanceof Error ? error.message : '服务器错误');
    }
  }
}

export function jsonError(ctx: RequestContext, status: number, message: string) {
  ctx.sendJson({ error: message }, status);
}

export function parseCookies(header = '') {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

export function setCookie(ctx: RequestContext, name: string, value: string, opts: { httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; secure?: boolean; path?: string; maxAge?: number } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const current = ctx.res.getHeader('set-cookie');
  const next = Array.isArray(current) ? [...current, parts.join('; ')] : current ? [String(current), parts.join('; ')] : parts.join('; ');
  ctx.res.setHeader('set-cookie', next);
}

export function deleteCookie(ctx: RequestContext, name: string, path = '/') {
  setCookie(ctx, name, '', { path, maxAge: 0 });
}

export function cors(origin = 'http://localhost:5173'): Middleware {
  return async (ctx, next) => {
    const requestOrigin = ctx.header('origin');
    if (requestOrigin && requestOrigin === origin) {
      ctx.res.setHeader('access-control-allow-origin', requestOrigin);
      ctx.res.setHeader('access-control-allow-credentials', 'true');
      ctx.res.setHeader('vary', 'Origin');
    }
    ctx.res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    ctx.res.setHeader('access-control-allow-headers', 'content-type');
    if (ctx.method === 'OPTIONS') { ctx.res.writeHead(204); ctx.res.end(); return; }
    await next?.();
  };
}

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

export async function serveStaticOrSpa(ctx: RequestContext, rootDir: string) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return jsonError(ctx, 405, statusText[405]);
  const root = resolve(rootDir);
  const requested = normalize(decodeURIComponent(ctx.path));
  let file = resolve(join(root, requested));
  if (!file.startsWith(root)) return jsonError(ctx, 404, 'Not found');
  let st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) { file = join(root, 'index.html'); st = await stat(file).catch(() => undefined); }
  if (!st?.isFile()) return jsonError(ctx, 404, 'Not found');
  ctx.res.writeHead(200, { 'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if (ctx.method === 'HEAD') ctx.res.end(); else createReadStream(file).pipe(ctx.res);
}
