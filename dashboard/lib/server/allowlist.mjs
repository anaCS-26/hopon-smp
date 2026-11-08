// The only agent routes the browser can reach through /api/agent/*. Anything else is a 404
// before it is signed. (The agent checks permissions again; this is defence in depth.)
const ID = '[a-z0-9]{3,32}';
const MOD = '[A-Za-z0-9_-]{2,64}';
const USER = `(?:me|[a-z0-9]{6,32})`;

/** @type {Array<[string, RegExp]>} */
export const ALLOWED = [
  ['GET', /^me$/],
  ['GET', /^status$/],
  ['GET', /^activity$/],
  ['GET', /^server\/log$/],
  ['POST', /^server\/(start|stop|restart|console)$/],
  ['GET', /^worlds$/],
  ['POST', /^worlds$/],
  ['GET', new RegExp(`^worlds/${ID}$`)],
  ['PATCH', new RegExp(`^worlds/${ID}$`)],
  ['PATCH', new RegExp(`^worlds/${ID}/settings$`)],
  ['POST', new RegExp(`^worlds/${ID}/(activate|reset|delete|mods|pack-ticket|backups|restore)$`)],
  ['GET', new RegExp(`^worlds/${ID}/backups$`)],
  ['DELETE', new RegExp(`^worlds/${ID}/mods/${MOD}$`)],
  ['DELETE', new RegExp(`^worlds/${ID}/pack$`)],
  ['GET', /^backups$/],
  ['GET', /^mods\/search$/],
  ['GET', new RegExp(`^mods/project/${MOD}$`)],
  ['POST', /^queue$/],
  ['DELETE', new RegExp(`^queue/${ID}$`)],
  ['GET', /^users$/],
  ['PATCH', new RegExp(`^users/[a-z0-9]{6,32}$`)],
  ['POST', new RegExp(`^users/${USER}/(mc-name|logout-all)$`)],
  ['POST', new RegExp(`^users/[a-z0-9]{6,32}/whitelist$`)],
  ['GET', /^invites$/],
  ['POST', /^invites$/],
  ['DELETE', new RegExp(`^invites/${ID}$`)],
  ['GET', /^audit$/],
];

const QUERY_KEYS = new Set(['q', 'offset', 'lines', 'limit']);

/**
 * Map a browser request to an agent path, or null if not allowed.
 * @param {string} method
 * @param {string[]} segments  path segments after /api/agent/
 * @param {URLSearchParams} search
 * @returns {string | null}
 */
export function toAgentPath(method, segments, search) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 5) return null;
  if (segments.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s))) return null;
  const p = segments.join('/');
  if (!ALLOWED.some(([m, re]) => m === method && re.test(p))) return null;
  const qs = new URLSearchParams();
  if (method === 'GET') {
    for (const [k, v] of search) {
      if (QUERY_KEYS.has(k) && v.length <= 80) qs.set(k, v);
    }
  }
  const q = qs.toString();
  return `/v1/${p}${q ? `?${q}` : ''}`;
}

/**
 * CSRF check for state-changing requests: same Origin, and the session's token in a header.
 * @param {{ method: string, origin: string | null, host: string | null, csrfHeader: string | null, sessionCsrf: string, expectedOrigin?: string }} r
 */
export function csrfOk({ method, origin, host, csrfHeader, sessionCsrf, expectedOrigin }) {
  if (method === 'GET' || method === 'HEAD') return true;
  if (!origin) return false;
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (expectedOrigin ? o.origin !== expectedOrigin : !host || o.host !== host) return false;
  if (!csrfHeader || !sessionCsrf || csrfHeader.length !== sessionCsrf.length) return false;
  let diff = 0;
  for (let i = 0; i < csrfHeader.length; i++) diff |= csrfHeader.charCodeAt(i) ^ sessionCsrf.charCodeAt(i);
  return diff === 0;
}
