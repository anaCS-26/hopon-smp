// Modrinth API client. The agent - not the browser - talks to Modrinth, applies the filters
// (Fabric, the server's Minecraft version, not client-only) and verifies sha512 downloads.
import crypto from 'node:crypto';
import { ValidationError, MODRINTH_ID_RE, SHA512_RE } from './validate.mjs';

const API = 'https://api.modrinth.com/v2';
const UA = 'anaCS-26/hopon-mc-agent/0.1 (github.com/anaCS-26)';
export const MAX_MOD_BYTES = 64 * 1024 * 1024;
const ALLOWED_FILE_HOSTS = new Set(['cdn.modrinth.com']);

/** Mods every world has and nobody can remove (EasyAuth is what makes offline mode safe). */
export const PROTECTED_MODS = {
  'fabric-api': 'almost every Fabric mod needs it',
  easyauth: 'it stops people joining as someone else (offline mode)',
};
/** Installed into new worlds by default, removable. */
export const DEFAULT_MODS = ['fabric-api', 'easyauth', 'lithium', 'ferrite-core'];

/** Hand-picked, well-known server-side mods shown first in the Mod Shop. */
export const STARTER_PICKS = [
  { slug: 'lithium', why: 'Faster server ticks, no gameplay changes.' },
  { slug: 'ferrite-core', why: 'Uses less memory. Great on our small server.' },
  { slug: 'chunky', why: 'Pre-generates the map so exploring lags less.' },
  { slug: 'spark', why: 'Shows what is causing lag.' },
  { slug: 'carpet', why: 'Technical tweaks and tools for redstone fans.' },
  { slug: 'universal-graves', why: 'Your items go into a grave when you die.' },
  { slug: 'styled-chat', why: 'Nicer chat formatting.' },
  { slug: 'vanilla-refresh', why: 'Small vanilla-style improvements.' },
];

export class ModrinthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ModrinthError';
    this.status = status;
  }
}

export function createModrinth({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  async function getJson(path) {
    const res = await fetchImpl(API + path, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) throw new ModrinthError('not found on Modrinth', 404);
    if (!res.ok) throw new ModrinthError(`Modrinth answered ${res.status}`);
    return res.json();
  }

  return {
    /** Search Fabric mods for one game version. Client-only mods are filtered out. */
    async search({ query = '', mcVersion, offset = 0, limit = 20 }) {
      if (typeof query !== 'string' || query.length > 80) throw new ValidationError('search text is too long');
      const facets = JSON.stringify([
        ['project_type:mod'],
        ['categories:fabric'],
        [`versions:${mcVersion}`],
        ['server_side:required', 'server_side:optional'],
      ]);
      const qs = new URLSearchParams({ query, facets, limit: String(Math.min(limit, 30)), offset: String(Math.max(0, Math.min(offset, 500))), index: query ? 'relevance' : 'downloads' });
      const data = await getJson(`/search?${qs}`);
      return {
        total: data.total_hits,
        hits: (data.hits || []).map((h) => ({
          projectId: h.project_id,
          slug: h.slug,
          title: h.title,
          description: h.description,
          author: h.author,
          downloads: h.downloads,
          follows: h.follows,
          iconUrl: safeIcon(h.icon_url),
          clientSide: h.client_side,
          serverSide: h.server_side,
          updated: h.date_modified,
          url: `https://modrinth.com/mod/${encodeURIComponent(h.slug)}`,
          license: h.license,
        })),
      };
    },

    async project(idOrSlug) {
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(idOrSlug)) throw new ValidationError('bad project id');
      return getJson(`/project/${idOrSlug}`);
    },

    /** Versions of a project that fit our loader and game version, newest first. */
    async compatibleVersions(idOrSlug, mcVersion) {
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(idOrSlug)) throw new ValidationError('bad project id');
      const qs = new URLSearchParams({ loaders: JSON.stringify(['fabric']), game_versions: JSON.stringify([mcVersion]) });
      const list = await getJson(`/project/${idOrSlug}/version?${qs}`);
      return list.filter((v) => isCompatible(v, mcVersion)).map(summarizeVersion);
    },

    async version(versionId) {
      if (!MODRINTH_ID_RE.test(versionId)) throw new ValidationError('bad version id');
      return getJson(`/version/${versionId}`);
    },

    /** Download a file and check its sha512. Returns the bytes. */
    async download(file) {
      checkFile(file);
      const res = await fetchImpl(file.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new ModrinthError(`download failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_MOD_BYTES) throw new ModrinthError('file is too large');
      const got = crypto.createHash('sha512').update(buf).digest('hex');
      if (got !== file.hashes.sha512) throw new ModrinthError('checksum mismatch: the download does not match what Modrinth published', 502);
      return buf;
    },
  };
}

function safeIcon(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'cdn.modrinth.com' ? u.href : null;
  } catch {
    return null;
  }
}

export function isCompatible(v, mcVersion) {
  return Array.isArray(v.loaders) && v.loaders.includes('fabric') && Array.isArray(v.game_versions) && v.game_versions.includes(mcVersion);
}

export function primaryFile(v) {
  const jars = (v.files || []).filter((f) => typeof f.filename === 'string' && f.filename.endsWith('.jar'));
  return jars.find((f) => f.primary) || jars[0] || null;
}

export function summarizeVersion(v) {
  const f = primaryFile(v);
  return {
    versionId: v.id,
    projectId: v.project_id,
    name: v.name,
    versionNumber: v.version_number,
    type: v.version_type,
    published: v.date_published,
    downloads: v.downloads,
    gameVersions: v.game_versions,
    file: f ? { filename: f.filename, size: f.size } : null,
    requiredDeps: (v.dependencies || []).filter((d) => d.dependency_type === 'required').map((d) => d.project_id).filter(Boolean),
  };
}

/** Throws unless the file is a jar on Modrinth's CDN with a proper sha512 and sane size. */
export function checkFile(file) {
  if (!file) throw new ModrinthError('this version has no .jar file', 400);
  let u;
  try {
    u = new URL(file.url);
  } catch {
    throw new ModrinthError('bad download url', 400);
  }
  if (u.protocol !== 'https:' || !ALLOWED_FILE_HOSTS.has(u.hostname)) throw new ModrinthError('download is not on cdn.modrinth.com', 400);
  if (!SHA512_RE.test(file.hashes?.sha512 || '')) throw new ModrinthError('Modrinth did not publish a sha512 for this file', 400);
  if (!/^[A-Za-z0-9._+-]{1,128}\.jar$/.test(file.filename)) throw new ModrinthError('unexpected file name', 400);
  if (typeof file.size === 'number' && file.size > MAX_MOD_BYTES) throw new ModrinthError('file is too large', 400);
}

/**
 * Check a version object fetched from Modrinth against what the server can run.
 * project: the project object (for project_type / server_side).
 */
export function assertInstallable(project, version, mcVersion) {
  if (project.project_type !== 'mod') throw new ModrinthError(`"${project.title}" is a ${project.project_type}, not a mod`, 400);
  if (project.server_side === 'unsupported') {
    throw new ModrinthError(`"${project.title}" only runs on players' own computers (for example shaders or minimaps). See Guides to install it yourself.`, 400);
  }
  if (version.project_id !== project.id) throw new ModrinthError('version does not belong to that project', 400);
  if (!isCompatible(version, mcVersion)) throw new ModrinthError(`this version is not for Fabric on Minecraft ${mcVersion}`, 400);
  const f = primaryFile(version);
  checkFile(f);
  return f;
}
