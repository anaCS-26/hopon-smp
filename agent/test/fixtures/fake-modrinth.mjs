// Offline stand-in for the Modrinth client (tests and `npm run mock -- --offline`).
// It runs the real validation (assertInstallable is called by the service), with fixed data.
import crypto from 'node:crypto';
import { ModrinthError, summarizeVersion, isCompatible } from '../../src/modrinth.mjs';

const jar = (slug) => Buffer.from(`fake jar for ${slug}`);
const sha512 = (b) => crypto.createHash('sha512').update(b).digest('hex');

const P = (id, slug, title, client_side, server_side, project_type = 'mod', downloads = 1000) => ({
  id, slug, title, description: `${title} (fixture)`, client_side, server_side, project_type, downloads, icon_url: null, license: { id: 'MIT' },
});

export const PROJECTS = [
  P('P7dR8mSH', 'fabric-api', 'Fabric API', 'optional', 'required', 'mod', 9e7),
  P('aZj58GfX', 'easyauth', 'EasyAuth', 'unsupported', 'required', 'mod', 4e5),
  P('gvQqBUqZ', 'lithium', 'Lithium', 'optional', 'optional', 'mod', 3e7),
  P('uXXizFIs', 'ferrite-core', 'FerriteCore', 'optional', 'optional', 'mod', 2e7),
  P('fALzjamp', 'chunky', 'Chunky', 'unsupported', 'required', 'mod', 4e6),
  P('YL57xq9U', 'iris', 'Iris Shaders', 'required', 'unsupported', 'mod', 5e7),
  P('cl0thCfg', 'cloth-config', 'Cloth Config API', 'required', 'required', 'mod', 6e7),
  P('gr4vesXX', 'universal-graves', 'Universal Graves', 'optional', 'required', 'mod', 2e6),
  P('shAder01', 'complementary', 'Complementary Shaders', 'required', 'unsupported', 'shader', 3e6),
];

function versionFor(p, mc = '26.3', opts = {}) {
  const bytes = jar(p.slug);
  return {
    id: (p.id.slice(0, 4) + 'ver1').slice(0, 8),
    project_id: p.id,
    name: `${p.title} 1.0`,
    version_number: '1.0.0',
    version_type: 'release',
    date_published: '2026-10-01T00:00:00Z',
    downloads: 100,
    loaders: opts.loaders || ['fabric'],
    game_versions: [mc],
    dependencies: p.slug === 'universal-graves' ? [{ project_id: 'cl0thCfg', dependency_type: 'required' }] : [],
    files: [{ url: opts.url || `https://cdn.modrinth.com/data/${p.id}/versions/x/${p.slug}.jar`, filename: `${p.slug}-1.0.0.jar`, primary: true, size: bytes.length, hashes: { sha512: opts.badHash ? 'f'.repeat(128) : sha512(bytes), sha1: 'x' } }],
  };
}

export function createFakeModrinth({ mcVersion = '26.3', overrides = {} } = {}) {
  const versions = new Map();
  for (const p of PROJECTS) versions.set(versionFor(p, mcVersion, overrides[p.slug]).id, versionFor(p, mcVersion, overrides[p.slug]));
  const proj = (idOrSlug) => PROJECTS.find((p) => p.id === idOrSlug || p.slug === idOrSlug);
  return {
    downloads: [],
    async search({ query }) {
      const q = String(query).toLowerCase();
      const hits = PROJECTS.filter((p) => p.project_type === 'mod' && p.server_side !== 'unsupported' && (!q || p.title.toLowerCase().includes(q)));
      return { total: hits.length, hits: hits.map((p) => ({ projectId: p.id, slug: p.slug, title: p.title, description: p.description, author: 'fixture', downloads: p.downloads, follows: 1, iconUrl: null, clientSide: p.client_side, serverSide: p.server_side, updated: '2026-10-01', url: `https://modrinth.com/mod/${p.slug}`, license: 'MIT' })) };
    },
    async project(idOrSlug) {
      const p = proj(idOrSlug);
      if (!p) throw new ModrinthError('not found on Modrinth', 404);
      return p;
    },
    async compatibleVersions(idOrSlug, mc) {
      const p = proj(idOrSlug);
      if (!p) throw new ModrinthError('not found on Modrinth', 404);
      return [...versions.values()].filter((v) => v.project_id === p.id && isCompatible(v, mc)).map(summarizeVersion);
    },
    async version(id) {
      const v = versions.get(id);
      if (!v) throw new ModrinthError('not found on Modrinth', 404);
      return v;
    },
    async download(file) {
      const slug = file.filename.replace(/-1\.0\.0\.jar$/, '');
      const bytes = jar(slug);
      if (sha512(bytes) !== file.hashes.sha512) throw new ModrinthError('checksum mismatch: the download does not match what Modrinth published', 502);
      this.downloads.push(file.filename);
      return bytes;
    },
    versionIdFor: (slug) => [...versions.values()].find((v) => v.project_id === proj(slug).id).id,
  };
}
