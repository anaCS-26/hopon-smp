// HTTP layer: signature check, rate limits, routing, JSON in/out. No business logic here.
import http from 'node:http';
import fs from 'node:fs';
import { verifyRequest, NonceCache } from './hmac.mjs';
import { RateLimiter } from './ratelimit.mjs';
import { ValidationError } from './validate.mjs';
import { PACK_LIMITS } from './zip.mjs';

const MAX_JSON = 64 * 1024;
const ID = '([a-z0-9]{3,32})';
const MODRINTH = '([A-Za-z0-9_-]{2,64})';

/** [method, pattern, rateClass, handler(ctx)] */
function buildRoutes(svc) {
  const r = (method, path, cls, fn) => [method, new RegExp(`^${path}$`), cls, fn];
  return [
    r('POST', '/v1/auth/login', 'login', (c) => svc.login(c.body)),
    r('GET', '/v1/me', 'read', (c) => svc.me(c.user)),
    r('GET', '/v1/status', 'read', (c) => svc.status(c.user)),
    r('GET', '/v1/activity', 'read', (c) => svc.activity(c.user)),
    r('POST', '/v1/server/start', 'heavy', (c) => svc.start(c.user)),
    r('POST', '/v1/server/stop', 'heavy', (c) => svc.stop(c.user)),
    r('POST', '/v1/server/restart', 'heavy', (c) => svc.restart(c.user)),
    r('POST', '/v1/server/console', 'write', (c) => svc.consoleCommand(c.user, c.body.command)),
    r('GET', '/v1/server/log', 'read', (c) => svc.log(c.user, c.query.get('lines'))),

    r('GET', '/v1/worlds', 'read', (c) => svc.listWorlds(c.user)),
    r('POST', '/v1/worlds', 'heavy', (c) => svc.createWorld(c.user, c.body)),
    r('GET', `/v1/worlds/${ID}`, 'read', (c) => svc.getWorld(c.user, c.p[0])),
    r('PATCH', `/v1/worlds/${ID}`, 'write', (c) => svc.renameWorld(c.user, c.p[0], c.body)),
    r('PATCH', `/v1/worlds/${ID}/settings`, 'write', (c) => svc.updateSettings(c.user, c.p[0], c.body)),
    r('POST', `/v1/worlds/${ID}/activate`, 'heavy', (c) => svc.activateWorld(c.user, c.p[0])),
    r('POST', `/v1/worlds/${ID}/reset`, 'heavy', (c) => svc.resetWorld(c.user, c.p[0], c.body)),
    r('POST', `/v1/worlds/${ID}/delete`, 'heavy', (c) => svc.deleteWorld(c.user, c.p[0], c.body)),
    r('POST', `/v1/worlds/${ID}/mods`, 'heavy', (c) => svc.installMod(c.user, c.p[0], c.body)),
    r('DELETE', `/v1/worlds/${ID}/mods/${MODRINTH}`, 'heavy', (c) => svc.removeMod(c.user, c.p[0], c.p[1])),
    r('POST', `/v1/worlds/${ID}/pack-ticket`, 'write', (c) => svc.packTicket(c.user, c.p[0])),
    r('DELETE', `/v1/worlds/${ID}/pack`, 'write', (c) => svc.removePack(c.user, c.p[0])),
    r('GET', `/v1/worlds/${ID}/backups`, 'read', (c) => svc.listBackups(c.user, c.p[0])),
    r('POST', `/v1/worlds/${ID}/backups`, 'heavy', (c) => svc.backupNow(c.user, c.p[0])),
    r('POST', `/v1/worlds/${ID}/restore`, 'heavy', (c) => svc.restoreBackup(c.user, c.p[0], c.body)),
    r('GET', '/v1/backups', 'read', (c) => svc.listBackups(c.user)),

    r('GET', '/v1/mods/search', 'read', (c) => svc.modSearch(c.user, { q: c.query.get('q') || '', offset: c.query.get('offset') })),
    r('GET', `/v1/mods/project/${MODRINTH}`, 'read', (c) => svc.modVersions(c.user, c.p[0])),

    r('POST', '/v1/queue', 'write', (c) => svc.joinQueue(c.user, c.body)),
    r('DELETE', `/v1/queue/${ID}`, 'write', (c) => svc.leaveQueue(c.user, c.p[0])),

    r('GET', '/v1/users', 'read', (c) => svc.listUsers(c.user)),
    r('PATCH', `/v1/users/${ID}`, 'write', (c) => svc.updateUser(c.user, c.p[0], c.body)),
    r('POST', `/v1/users/(me|[a-z0-9]{6,32})/mc-name`, 'write', (c) => svc.setMcName(c.user, c.p[0], c.body.mcName)),
    r('POST', `/v1/users/${ID}/whitelist`, 'heavy', (c) => svc.whitelistUser(c.user, c.p[0])),
    r('POST', `/v1/users/(me|[a-z0-9]{6,32})/logout-all`, 'write', (c) => svc.logoutAll(c.user, c.p[0])),

    r('GET', '/v1/invites', 'read', (c) => svc.listInvites(c.user)),
    r('POST', '/v1/invites', 'write', (c) => svc.createInvite(c.user, c.body)),
    r('DELETE', `/v1/invites/${ID}`, 'write', (c) => svc.revokeInvite(c.user, c.p[0])),

    r('GET', '/v1/audit', 'read', (c) => svc.readAudit(c.user, c.query.get('limit'))),
  ];
}

function send(res, status, body, extra = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(Object.assign(new Error('request body too large'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHttpServer({ svc, keys, config, log = console, rateClasses }) {
  const routes = buildRoutes(svc);
  const nonces = new NonceCache();
  const limiter = new RateLimiter(rateClasses);
  const corsOrigin = config.dashboardOrigin;

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://agent.local');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });

      // Public, content-addressed resource packs for players' game clients.
      const pm = /^\/packs\/([a-f0-9]{40})\.zip$/.exec(pathname);
      if (pm && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = svc.isKnownPack(pm[1]) ? config.packFile(pm[1]) : null;
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        const st = fs.statSync(file);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': st.size, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file).pipe(res);
      }

      // Browser upload of a resource pack, authorised by a one-time ticket.
      const um = /^\/v1\/uploads\/([A-Za-z0-9_-]{43})$/.exec(pathname);
      if (um) {
        const cors = corsOrigin && req.headers.origin === corsOrigin
          ? { 'access-control-allow-origin': corsOrigin, vary: 'Origin' }
          : {};
        if (req.method === 'OPTIONS') {
          return send(res, 204, undefined, { ...cors, 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': 'content-type, x-file-name', 'access-control-max-age': '600' });
        }
        if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' }, cors);
        if (!cors['access-control-allow-origin'] && req.headers.origin) return send(res, 403, { error: 'origin not allowed' });
        const rl = limiter.take(`ip:${req.socket.remoteAddress}`, 'upload');
        if (!rl.ok) return send(res, 429, { error: 'too many uploads, slow down' }, { ...cors, 'retry-after': String(rl.retryAfter) });
        const body = await readBody(req, PACK_LIMITS.maxBytes);
        const out = await svc.uploadPack(um[1], body, req.headers['x-file-name']);
        return send(res, 200, out, cors);
      }

      if (!pathname.startsWith('/v1/')) return send(res, 404, { error: 'not found' });

      const route = routes.find(([m, re]) => m === req.method && re.test(pathname));
      // Read the body before deciding, so the signature covers it.
      const raw = await readBody(req, MAX_JSON);
      const v = verifyRequest({ keys, nonces, method: req.method, path: req.url, headers: req.headers, rawBody: raw });
      if (!v.ok) {
        log.warn?.(`[auth] ${req.method} ${pathname}: ${v.reason}`);
        return send(res, 401, { error: 'unauthorised' });
      }
      if (!route) return send(res, 404, { error: 'not found' });
      const [, re, cls, fn] = route;

      const isLogin = pathname === '/v1/auth/login';
      if (isLogin !== (v.actor === 'system:login')) return send(res, 403, { error: 'wrong actor for this route' });
      const user = isLogin ? null : svc.resolveActor(v.actor);

      const rl = limiter.take(isLogin ? 'system' : user.id, cls);
      if (!rl.ok) return send(res, 429, { error: `slow down a little (try again in ${rl.retryAfter}s)` }, { 'retry-after': String(rl.retryAfter) });

      let body = {};
      if (raw.length) {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, { error: 'bad JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'body must be a JSON object' });
      }
      const out = await fn({ user, body, query: url.searchParams, p: re.exec(pathname).slice(1) });
      return send(res, out && out.job ? 202 : 200, out);
    } catch (e) {
      const status = e instanceof ValidationError ? 400 : Number.isInteger(e.status) ? e.status : 500;
      if (status >= 500) log.error?.(`[error] ${req.method} ${pathname}:`, e);
      return send(res, status, { error: status >= 500 && !e.status ? 'something went wrong on the server' : e.message, ...(e.field ? { field: e.field } : {}) });
    }
  };

  const server = http.createServer(handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
