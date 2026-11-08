// Who may do what. Pure functions, no I/O, so they are easy to test.
//
// Roles: owner (the Team Leader, exactly one), admin (trusted helpers), member (friends).
// World host: the user who created a world. Hosts handle their world's sensitive actions.

export const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
export const ROLES = Object.keys(ROLE_RANK);

export const QUOTA = { member: 3, admin: 5, owner: Infinity };
export const MAX_WORLDS_TOTAL = 12;

/**
 * Action table.
 *  any        - any active user
 *  admin      - admin or owner
 *  owner      - owner only
 *  host       - host of ctx.world, admin, or owner            (day-to-day world management)
 *  hostOwner  - host of ctx.world, or owner (not admins)      (sensitive: delete, reset, restore)
 *  activeHost - host of the currently active world, admin, or owner
 */
export const ACTIONS = {
  'status.read': 'any',
  'worlds.read': 'any',
  'backups.read': 'any',
  'users.read': 'any',
  'mods.search': 'any',
  'queue.join': 'any',
  'self.update': 'any',
  'server.start': 'any',
  'console.basic': 'any',
  'world.create': 'any',

  'server.stop': 'activeHost',
  'server.restart': 'activeHost',
  'console.host': 'activeHost',

  'world.activate': 'host',
  'world.settings': 'host',
  'world.rename': 'host',
  'mods.manage': 'host',
  'pack.manage': 'host',
  'backup.create': 'host',

  'world.delete': 'hostOwner',
  'world.reset': 'hostOwner',
  'world.restore': 'hostOwner',

  'console.admin': 'admin',
  'users.whitelist': 'admin',
  'audit.read': 'admin',
  'queue.manage': 'admin',

  'users.manage': 'owner',
  'invites.manage': 'owner',
  'server.upgrade': 'owner',
};

const rank = (user) => ROLE_RANK[user?.role] ?? 0;

/**
 * Decide. Returns { allow: true } or { allow: false, reason }.
 * ctx: { world?, activeWorld?, playersOnline?: number, ownWorldCount?: number, totalWorlds?: number }
 */
export function decide(user, action, ctx = {}) {
  if (!user || user.status !== 'active') return deny('your account is not active');
  const rule = ACTIONS[action];
  if (!rule) return deny(`unknown action ${action}`);

  const isAdmin = rank(user) >= ROLE_RANK.admin;
  const isOwner = user.role === 'owner';
  const hosts = (w) => !!w && w.hostId === user.id;

  let ok;
  switch (rule) {
    case 'any': ok = true; break;
    case 'admin': ok = isAdmin; break;
    case 'owner': ok = isOwner; break;
    case 'host': ok = !!ctx.world && (hosts(ctx.world) || isAdmin); break;
    case 'hostOwner': ok = !!ctx.world && (hosts(ctx.world) || isOwner); break;
    case 'activeHost': ok = hosts(ctx.activeWorld) || isAdmin; break;
    default: ok = false;
  }
  if (!ok) return deny(explain(rule));

  // Extra rules on top of the table.
  if (action === 'world.create') {
    if ((ctx.totalWorlds ?? 0) >= MAX_WORLDS_TOTAL) return deny(`the server already has ${MAX_WORLDS_TOTAL} worlds; ask the Team Leader to clean up`);
    const quota = QUOTA[user.role] ?? 0;
    if ((ctx.ownWorldCount ?? 0) >= quota) return deny(`you can host up to ${quota} worlds; delete one first`);
  }

  if (action === 'world.activate' && ctx.activeWorld && ctx.world && ctx.activeWorld.id !== ctx.world.id) {
    // Kicking people off someone else's world needs that world's host or an admin.
    const canInterrupt = hosts(ctx.activeWorld) || isAdmin;
    if ((ctx.playersOnline ?? 0) > 0 && !canInterrupt) {
      return deny('people are playing right now; join the queue and the current host will switch when they are done');
    }
  }
  return { allow: true };
}

export function can(user, action, ctx) {
  return decide(user, action, ctx).allow;
}

function deny(reason) {
  return { allow: false, reason };
}

function explain(rule) {
  switch (rule) {
    case 'admin': return 'only admins and the Team Leader can do that';
    case 'owner': return 'only the Team Leader can do that';
    case 'host': return "only this world's host (or an admin) can do that";
    case 'hostOwner': return "only this world's host (or the Team Leader) can do that";
    case 'activeHost': return 'only the host of the running world (or an admin) can do that';
    default: return 'not allowed';
  }
}

/** Console level -> action name. */
export function consoleAction(level) {
  return level === 'basic' ? 'console.basic' : level === 'host' ? 'console.host' : 'console.admin';
}

/** Which actions a user can do on a given world, for the UI to show or hide buttons. */
export function worldCapabilities(user, world, ctx = {}) {
  const c = { ...ctx, world };
  const keys = ['world.activate', 'world.settings', 'world.rename', 'mods.manage', 'pack.manage', 'backup.create', 'world.delete', 'world.reset', 'world.restore'];
  return Object.fromEntries(keys.map((k) => [k, can(user, k, c)]));
}

/** Rarity tiers for fun titles (colour in the UI). */
export const TITLE_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
