// Fake crew, worlds and backups so the dashboard has something to show in mock mode.
// Mock Discord ids 1000...0001-0004 can be picked on the dashboard's dev login screen.
import { DEFAULT_SETTINGS } from './properties.mjs';

const baseMods = (by) => [
  mod('P7dR8mSH', 'fabric-api', 'Fabric API', '0.140.0+26.3', 'optional', 'required', by, true),
  mod('aZj58GfX', 'easyauth', 'EasyAuth', '3.4.4', 'unsupported', 'required', by, true),
  mod('gvQqBUqZ', 'lithium', 'Lithium', '0.21.0', 'optional', 'optional', by),
  mod('uXXizFIs', 'ferrite-core', 'FerriteCore', '8.0.2', 'optional', 'optional', by),
];

function mod(projectId, slug, title, versionNumber, clientSide, serverSide, by, prot = false) {
  return {
    projectId, slug, title, versionId: 'mockver' + slug.slice(0, 1), versionNumber, gameVersions: ['26.3'],
    filename: `${slug}--${versionNumber}.jar`, sha512: '0'.repeat(128), size: 1_000_000, clientSide, serverSide,
    iconUrl: null, requires: [], protected: prot, addedBy: by, addedAt: new Date(Date.now() - 864e5 * 3).toISOString(),
  };
}

export function seed(store, system) {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const users = [
    ['u0leader00', '100000000000000001', 'Leader', 'owner', 'Team Leader', 'legendary', 'TeamLeader', 'whitelisted'],
    ['u0zbeast00', '100000000000000002', 'Zbeast', 'admin', 'Redstone Wizard', 'epic', 'Zbeast', 'whitelisted'],
    ['u0panda000', '100000000000000003', 'PixelPanda', 'member', 'Professional Cave Explorer', 'rare', 'PixelPanda', 'whitelisted'],
    ['u0mossy000', '100000000000000004', 'MossyMax', 'member', 'Chief Dirt Hut Architect', 'uncommon', 'MossyMax', 'pending'],
  ].map(([id, discordId, discordName, role, title, titleTier, mcName, mcStatus], i) => ({
    id, discordId, discordName, avatarUrl: null, role, title, titleTier, mcName, mcStatus, status: 'active', epoch: 1,
    createdAt: iso(864e5 * (10 - i)), lastSeenAt: iso(36e5 * i),
  }));

  store.mutate((s) => {
    s.users.push(...users);
    const hop = s.worlds.find((w) => w.id === 'hopon');
    if (hop) {
      hop.hostId = 'u0leader00';
      hop.mods = baseMods('u0leader00');
      hop.playMinutes = 840;
    }
    s.worlds.push(
      {
        id: 'wpanda01', name: 'Panda Skyblock', description: 'One tree, one island, zero mercy.', theme: 'end', hostId: 'u0panda000',
        createdAt: iso(864e5 * 4), createdVersion: '26.3', lastPlayedVersion: '26.3', settings: { ...DEFAULT_SETTINGS, motd: 'Panda Skyblock', 'level-type': 'minecraft:flat', difficulty: 'hard' },
        mods: [...baseMods('u0panda000'), mod('9eGKb6K1', 'universal-graves', 'Universal Graves', '3.9.0', 'optional', 'required', 'u0panda000')],
        resourcePack: null, status: 'ready', hasData: true, playMinutes: 190, lastActiveAt: iso(864e5 * 2),
      },
      {
        id: 'wcreate1', name: 'Creative Builds', description: 'Flat creative world for planning big builds.', theme: 'cherry', hostId: 'u0zbeast00',
        createdAt: iso(864e5 * 6), createdVersion: '26.3', lastPlayedVersion: '26.3', settings: { ...DEFAULT_SETTINGS, motd: 'Creative Builds', gamemode: 'creative', 'level-type': 'minecraft:flat', 'spawn-monsters': false },
        mods: baseMods('u0zbeast00'), resourcePack: null, status: 'ready', hasData: true, playMinutes: 75, lastActiveAt: iso(864e5 * 5),
      },
    );
    s.server.activations.push({ worldId: 'hopon', at: iso(864e5 * 8) });
    s.queue.push({ id: 'qmock0001', userId: 'u0panda000', worldId: 'wpanda01', note: 'Island challenge tonight?', at: iso(18e5) });
  });

  for (const [ago, file] of [
    [36e5 * 2, 'auto'], [36e5 * 8, 'auto'], [36e5 * 14, 'auto'], [864e5 * 2, 'wpanda01_manual'], [864e5 * 3, 'hopon_manual'], [864e5 * 5, 'wcreate1_premodremove'],
  ]) {
    const d = new Date(now - ago);
    const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
    system._debug.backups.push({ file: `world-${stamp}-${file}.tar.gz`, size: 18_000_000 + Math.floor(Math.random() * 9_000_000), mtime: d.toISOString() });
  }
  for (const [ago, actor, action, target] of [
    [864e5 * 6, 'u0zbeast00', 'world.create', 'wcreate1'],
    [864e5 * 4, 'u0panda000', 'world.create', 'wpanda01'],
    [864e5 * 3, 'u0panda000', 'mods.install', 'wpanda01'],
    [864e5 * 1, 'u0mossy000', 'auth.join', null],
    [36e5 * 3, 'u0leader00', 'server.start', 'hopon'],
  ]) {
    store.memAudit.push({ ts: iso(ago), actor, action, target, result: 'ok' });
  }
}
