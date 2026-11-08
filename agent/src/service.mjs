// Business logic: every dashboard action, with its permission check, validation, backup-first
// rule and audit entry. The HTTP layer (http.mjs) only parses requests and calls these.
import { decide, consoleAction, worldCapabilities, ROLE_RANK, TITLE_TIERS } from './policy.mjs';
import { validateSettings, DEFAULT_SETTINGS, settingsSchema } from './properties.mjs';
import { parseConsole, CONSOLE_HELP, gameruleList } from './console.mjs';
import { assertInstallable, primaryFile, PROTECTED_MODS, DEFAULT_MODS, STARTER_PICKS, isCompatible } from './modrinth.mjs';
import { inspectPack, PACK_LIMITS } from './zip.mjs';
import { ValidationError, cleanText, isMcName, offlineUuid, compareVersions, MODRINTH_ID_RE, assertWorldId } from './validate.mjs';
import { newId, hashCode } from './store.mjs';
import { randomToken } from './hmac.mjs';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const THEMES = ['grass', 'desert', 'snow', 'cherry', 'nether', 'end', 'ocean', 'mushroom'];
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const TICKET_TTL_MS = 10 * 60 * 1000;
const BACKUP_RE = /^world-(\d{8})-(\d{6})Z-([A-Za-z0-9_-]+)\.tar\.gz$/;

export function createService({ store, system, modrinth, config, notify = async () => {} }) {
  const tickets = new Map();
  let job = null;
  let lastJob = null;
  let statusCache = null;

  // ------------------------------------------------------------------ helpers
  const mcVersion = () => store.s.server.mcVersion;

  function authorize(user, action, ctx = {}) {
    const d = decide(user, action, { activeWorld: store.activeWorld(), ...ctx });
    if (!d.allow) {
      store.audit({ actor: user?.id ?? 'unknown', action, target: ctx.world?.id, result: 'denied', reason: d.reason });
      throw new HttpError(403, d.reason);
    }
  }

  function audit(user, action, target, details) {
    store.audit({ actor: user?.id ?? 'system', actorName: user?.discordName, action, target, result: 'ok', ...(details ? { details } : {}) });
  }

  function worldOr404(id) {
    assertWorldId(id);
    const w = store.world(id);
    if (!w) throw new HttpError(404, 'no such world');
    return w;
  }

  function requireConfirm(world, confirm) {
    if (typeof confirm !== 'string' || confirm.trim() !== world.name) {
      throw new HttpError(400, `type the world's name ("${world.name}") to confirm`);
    }
  }

  function publicUser(u, viewer) {
    if (!u) return null;
    const base = {
      id: u.id,
      name: u.discordName,
      avatarUrl: u.avatarUrl || null,
      role: u.role,
      title: u.title,
      titleTier: u.titleTier,
      mcName: u.mcName || null,
      mcStatus: u.mcStatus || 'none',
      status: u.status,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
    };
    if (u.mcName) base.offlineUuid = offlineUuid(u.mcName);
    if (viewer && (viewer.id === u.id || viewer.role === 'owner')) base.discordId = u.discordId;
    return base;
  }

  function miniUser(id) {
    const u = store.user(id);
    return u ? { id: u.id, name: u.discordName, title: u.title, titleTier: u.titleTier, avatarUrl: u.avatarUrl || null } : null;
  }

  function publicWorld(w, viewer) {
    const active = store.s.server.activeWorldId === w.id;
    return {
      id: w.id,
      name: w.name,
      description: w.description || '',
      theme: w.theme,
      host: miniUser(w.hostId),
      createdAt: w.createdAt,
      createdVersion: w.createdVersion,
      lastPlayedVersion: w.lastPlayedVersion,
      lastActiveAt: w.lastActiveAt,
      playMinutes: Math.round(w.playMinutes || 0),
      active,
      settings: w.settings,
      mods: w.mods,
      resourcePack: w.resourcePack ? { ...w.resourcePack, url: packUrl(w.resourcePack.sha1) } : null,
      can: viewer ? worldCapabilities(viewer, w, { activeWorld: store.activeWorld(), playersOnline: statusCache?.players?.online ?? 0 }) : undefined,
    };
  }

  const packUrl = (sha1) => `${config.publicUrl.replace(/\/$/, '')}/packs/${sha1}.zip`;

  function packFor(w) {
    return w.resourcePack ? { url: packUrl(w.resourcePack.sha1), sha1: w.resourcePack.sha1 } : null;
  }

  /** Run a slow action in the background. One at a time; the UI follows it via /status. */
  function runJob(user, kind, label, fn) {
    if (job) throw new HttpError(409, `the server is busy: ${job.label}`);
    const j = { id: newId('j', 8), kind, label, step: 'starting', by: miniUser(user?.id), startedAt: new Date().toISOString() };
    job = j;
    const setStep = (step) => {
      j.step = step;
    };
    (async () => {
      try {
        const result = await fn(setStep);
        lastJob = { ...j, ok: true, result: result ?? null, finishedAt: new Date().toISOString() };
      } catch (e) {
        lastJob = { ...j, ok: false, error: String(e.message || e).slice(0, 300), finishedAt: new Date().toISOString() };
        store.audit({ actor: user?.id ?? 'system', action: `job.${kind}`, result: 'failed', reason: lastJob.error });
      } finally {
        job = null;
        statusCache = null;
      }
    })();
    return { job: j };
  }

  async function backupWorld(world, kind, setStep) {
    setStep?.(`backing up ${world.name}`);
    const active = store.s.server.activeWorldId === world.id;
    if (!active && !world.hasData) return null; // never played: nothing to back up
    const file = await system.backup(world.id, kind);
    audit(null, 'backup.auto', world.id, { kind });
    return file;
  }

  async function serviceRunning() {
    const s = await system.serviceState();
    return s === 'active' || s === 'activating';
  }

  function endSession() {
    const sess = store.s.server.session;
    if (!sess) return;
    store.mutate((s) => {
      const w = s.worlds.find((x) => x.id === sess.worldId);
      if (w) {
        w.playMinutes = (w.playMinutes || 0) + (Date.now() - Date.parse(sess.startedAt)) / 60000;
        w.lastActiveAt = new Date().toISOString();
      }
      s.server.session = null;
    });
  }

  function checkStartable(world) {
    if (!world) throw new HttpError(409, 'no world is selected; pick one on the Worlds page');
    if (!world.mods.some((m) => m.slug === 'easyauth')) {
      throw new HttpError(409, `${world.name} has no EasyAuth, so anyone could log in as anyone. Install EasyAuth first.`);
    }
    if (world.lastPlayedVersion && compareVersions(world.lastPlayedVersion, mcVersion()) > 0) {
      throw new HttpError(409, `${world.name} was played on ${world.lastPlayedVersion}, newer than the server (${mcVersion()}). Worlds cannot be downgraded.`);
    }
    const stale = world.mods.filter((m) => m.gameVersions && !m.gameVersions.includes(mcVersion()));
    if (stale.length) {
      throw new HttpError(409, `these mods are not built for ${mcVersion()} yet: ${stale.map((m) => m.title || m.slug).join(', ')}. Update or remove them first.`);
    }
  }

  async function startActive(user, setStep) {
    const world = store.activeWorld();
    checkStartable(world);
    if (world.lastPlayedVersion && compareVersions(world.lastPlayedVersion, mcVersion()) < 0) {
      await backupWorld(world, 'preupgrade', setStep);
    }
    setStep('starting the server');
    await system.start();
    store.mutate((s) => {
      s.server.session = { worldId: world.id, startedBy: user?.id ?? null, startedAt: new Date().toISOString() };
      s.server.pendingRestart = false;
      const w = s.worlds.find((x) => x.id === world.id);
      w.lastPlayedVersion = mcVersion();
      w.hasData = true;
    });
  }

  async function stopServer(setStep, warnSeconds = 0) {
    if (!(await serviceRunning())) return;
    if (warnSeconds > 0) {
      const p = await system.ping();
      if (p && p.online > 0) {
        setStep(`warning players (${warnSeconds}s)`);
        await system.sendCommand(`say The server is switching worlds in ${warnSeconds} seconds. Thanks for playing!`).catch(() => {});
        await sleep(warnSeconds * 1000 * (config.mockSpeedup ? 0.05 : 1));
      }
    }
    setStep('stopping the server (saving the world)');
    await system.stop();
    endSession();
  }

  // ------------------------------------------------------------------ boot / reconcile
  async function init() {
    const s = store.s;
    if (config.mcVersion) store.mutate((st) => void (st.server.mcVersion = config.mcVersion));
    const marker = await system.activeMarker();
    if (s.worlds.length === 0) {
      // First run: adopt the existing world (if any) as "Hop On SMP", hosted by the owner once they log in.
      const hasWorld = await system.worldExists();
      const mods = (await system.scanActiveMods?.()) || [];
      if (hasWorld || marker || config.mode === 'mock') {
        const id = marker || 'hopon';
        if (!marker) await system.adoptWorld(id);
        store.mutate((st) => {
          st.worlds.push({
            id,
            name: 'Hop On SMP',
            description: 'The original world, moved over from Aternos.',
            theme: 'grass',
            hostId: null, // claimed by the owner on first login
            createdAt: new Date().toISOString(),
            createdVersion: st.server.mcVersion,
            lastPlayedVersion: st.server.mcVersion,
            settings: { ...DEFAULT_SETTINGS },
            mods: mods.map((m) => ({ ...m, addedBy: null, addedAt: new Date().toISOString() })),
            resourcePack: null,
            status: 'ready',
            hasData: true,
            playMinutes: 60,
          });
          st.server.activeWorldId = id;
        });
      }
    } else if (marker && marker !== s.server.activeWorldId && store.world(marker)) {
      store.mutate((st) => void (st.server.activeWorldId = marker));
    }
  }

  // ------------------------------------------------------------------ auth & users
  function login({ discordId, discordName, avatarUrl, inviteCode }) {
    if (!/^\d{5,25}$/.test(String(discordId))) throw new ValidationError('bad discord id');
    const name = cleanText(String(discordName || 'player'), { field: 'name', max: 32 }) || 'player';
    const avatar = typeof avatarUrl === 'string' && /^https:\/\/cdn\.discordapp\.com\/[A-Za-z0-9/_.-]+(\?size=\d+)?$/.test(avatarUrl) ? avatarUrl : null;
    const now = new Date().toISOString();
    let user = store.userByDiscord(String(discordId));
    if (user) {
      if (user.status !== 'active') throw new HttpError(403, 'your dashboard access has been turned off; talk to the Team Leader');
      store.mutate(() => Object.assign(user, { discordName: name, avatarUrl: avatar, lastSeenAt: now }));
      store.audit({ actor: user.id, action: 'auth.login', result: 'ok' });
      return { user: publicUser(user, user), epoch: user.epoch };
    }
    let role;
    let title;
    let titleTier;
    let invite = null;
    if (config.ownerDiscordId && String(discordId) === String(config.ownerDiscordId) && !store.s.users.some((u) => u.role === 'owner')) {
      role = 'owner';
      title = 'Team Leader';
      titleTier = 'legendary';
    } else if (inviteCode) {
      const h = hashCode(String(inviteCode));
      invite = store.s.invites.find((i) => i.codeHash === h && !i.usedBy && Date.parse(i.expiresAt) > Date.now());
      if (!invite) throw new HttpError(403, 'that invite link is invalid, used or expired; ask for a new one');
      role = invite.role;
      title = invite.title;
      titleTier = invite.titleTier;
    } else {
      store.audit({ actor: `discord:${discordId}`, action: 'auth.login', result: 'denied', reason: 'not invited' });
      throw new HttpError(403, 'this dashboard is invite-only; ask the Team Leader for an invite link');
    }
    user = {
      id: newId('u', 10),
      discordId: String(discordId),
      discordName: name,
      avatarUrl: avatar,
      role,
      title,
      titleTier,
      mcName: null,
      mcStatus: 'none',
      status: 'active',
      epoch: 1,
      createdAt: now,
      lastSeenAt: now,
    };
    store.mutate((s) => {
      s.users.push(user);
      if (invite) Object.assign(invite, { usedBy: user.id, usedAt: now });
      // The owner claims any unhosted (adopted) worlds.
      if (role === 'owner') for (const w of s.worlds) if (!w.hostId) w.hostId = user.id;
    });
    store.audit({ actor: user.id, action: invite ? 'auth.join' : 'auth.owner-created', result: 'ok', target: invite?.id });
    return { user: publicUser(user, user), epoch: user.epoch };
  }

  function resolveActor(actor) {
    // actor = "user:<id>:<epoch>"
    const [, id, epoch] = actor.split(':');
    const u = store.user(id);
    if (!u) throw new HttpError(401, 'unknown user');
    if (u.status !== 'active') throw new HttpError(403, 'your dashboard access has been turned off');
    if (String(u.epoch) !== epoch) throw new HttpError(401, 'session expired, please log in again');
    return u;
  }

  function me(user) {
    return {
      user: publicUser(user, user),
      can: {
        manageUsers: decide(user, 'users.manage').allow,
        whitelist: decide(user, 'users.whitelist').allow,
        audit: decide(user, 'audit.read').allow,
        stop: decide(user, 'server.stop', { activeWorld: store.activeWorld() }).allow,
        consoleHost: decide(user, 'console.host', { activeWorld: store.activeWorld() }).allow,
      },
    };
  }

  function listUsers(user) {
    authorize(user, 'users.read');
    return { users: store.s.users.map((u) => publicUser(u, user)) };
  }

  function updateUser(user, id, patch = {}) {
    authorize(user, 'users.manage');
    const target = store.user(id);
    if (!target) throw new HttpError(404, 'no such user');
    const next = {};
    if (patch.role !== undefined) {
      if (!['member', 'admin'].includes(patch.role)) throw new ValidationError('role must be member or admin');
      if (target.role === 'owner') throw new HttpError(400, 'the Team Leader stays the Team Leader');
      next.role = patch.role;
    }
    if (patch.title !== undefined) next.title = cleanText(patch.title, { field: 'title', min: 1, max: 32 });
    if (patch.titleTier !== undefined) {
      if (!TITLE_TIERS.includes(patch.titleTier)) throw new ValidationError('unknown title tier');
      next.titleTier = patch.titleTier;
    }
    if (patch.status !== undefined) {
      if (!['active', 'disabled'].includes(patch.status)) throw new ValidationError('status must be active or disabled');
      if (target.id === user.id) throw new HttpError(400, "you can't turn off your own access");
      next.status = patch.status;
    }
    store.mutate(() => {
      Object.assign(target, next);
      if (next.status === 'disabled' || next.role) target.epoch += 1; // force a fresh login
    });
    audit(user, 'users.update', target.id, next);
    return { user: publicUser(target, user) };
  }

  function setMcName(user, id, mcName) {
    const target = id === 'me' ? user : store.user(id);
    if (!target) throw new HttpError(404, 'no such user');
    if (target.id !== user.id) authorize(user, 'users.whitelist');
    else authorize(user, 'self.update');
    if (!isMcName(mcName)) throw new ValidationError('Minecraft names are 3-16 letters, digits or _');
    const clash = store.s.users.find((u) => u.id !== target.id && u.mcName && u.mcName.toLowerCase() === mcName.toLowerCase());
    if (clash) throw new HttpError(409, 'someone on the crew already uses that name');
    if (target.mcStatus === 'whitelisted' && target.mcName === mcName) return { user: publicUser(target, user) };
    store.mutate(() => Object.assign(target, { mcName, mcStatus: 'pending' }));
    audit(user, 'users.mcname', target.id, { mcName });
    return { user: publicUser(target, user) };
  }

  async function whitelistUser(user, id) {
    authorize(user, 'users.whitelist');
    const target = store.user(id);
    if (!target?.mcName) throw new HttpError(400, 'that user has not set a Minecraft name yet');
    await system.whitelist(target.mcName);
    store.mutate(() => void (target.mcStatus = 'whitelisted'));
    audit(user, 'users.whitelist', target.id, { mcName: target.mcName, uuid: offlineUuid(target.mcName) });
    return { user: publicUser(target, user) };
  }

  function logoutAll(user, id) {
    const target = id === 'me' ? user : store.user(id);
    if (!target) throw new HttpError(404, 'no such user');
    if (target.id !== user.id) authorize(user, 'users.manage');
    store.mutate(() => void (target.epoch += 1));
    audit(user, 'users.logout-all', target.id);
    return { ok: true };
  }

  // ------------------------------------------------------------------ invites
  function listInvites(user) {
    authorize(user, 'invites.manage');
    return {
      invites: store.s.invites.map((i) => ({
        id: i.id, role: i.role, title: i.title, titleTier: i.titleTier, note: i.note, createdAt: i.createdAt, expiresAt: i.expiresAt,
        usedBy: miniUser(i.usedBy), usedAt: i.usedAt, expired: !i.usedBy && Date.parse(i.expiresAt) <= Date.now(),
      })),
    };
  }

  function createInvite(user, { role = 'member', title = 'Crew Member', titleTier = 'common', note = '' } = {}) {
    authorize(user, 'invites.manage');
    if (!['member', 'admin'].includes(role)) throw new ValidationError('role must be member or admin');
    if (!TITLE_TIERS.includes(titleTier)) throw new ValidationError('unknown title tier');
    const code = randomToken(16);
    const inv = {
      id: newId('i', 8),
      codeHash: hashCode(code),
      role,
      title: cleanText(title, { field: 'title', min: 1, max: 32 }),
      titleTier,
      note: cleanText(note, { field: 'note', max: 60 }),
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      usedBy: null,
      usedAt: null,
    };
    store.mutate((s) => s.invites.push(inv));
    audit(user, 'invites.create', inv.id, { role, title: inv.title });
    return { invite: { id: inv.id, expiresAt: inv.expiresAt }, code };
  }

  function revokeInvite(user, id) {
    authorize(user, 'invites.manage');
    const before = store.s.invites.length;
    store.mutate((s) => void (s.invites = s.invites.filter((i) => i.id !== id || i.usedBy)));
    if (store.s.invites.length === before) throw new HttpError(404, 'no such unused invite');
    audit(user, 'invites.revoke', id);
    return { ok: true };
  }

  // ------------------------------------------------------------------ status & server
  async function status(user) {
    authorize(user, 'status.read');
    if (!statusCache || Date.now() - statusCache.at > 1500) {
      const [svc, p, res] = await Promise.all([system.serviceState(), system.ping(), system.resources()]);
      let state = 'offline';
      if (svc === 'active') state = p ? 'online' : 'starting';
      else if (svc === 'activating') state = 'starting';
      else if (svc === 'deactivating') state = 'stopping';
      else if (svc === 'failed') state = 'crashed';
      statusCache = { at: Date.now(), state, players: p ? { online: p.online, max: p.max, names: p.sample } : { online: 0, max: 0, names: [] }, resources: res };
      if (state === 'online' && store.s.server.session && !store.s.server.session.announced) {
        store.mutate((s) => void (s.server.session.announced = true));
        notify(`🟢 **${store.activeWorld()?.name ?? 'The server'}** is online. Hop on: \`${config.joinAddress}\``).catch(() => {});
      }
    }
    const sess = store.s.server.session;
    const active = store.activeWorld();
    return {
      agent: { mode: config.mode, version: '0.1.0' },
      server: {
        state: statusCache.state,
        players: statusCache.players,
        mcVersion: mcVersion(),
        software: store.s.server.software,
        pendingRestart: store.s.server.pendingRestart,
        session: sess ? { world: sess.worldId, startedBy: miniUser(sess.startedBy), startedAt: sess.startedAt } : null,
        address: config.joinAddress,
      },
      activeWorld: active ? { id: active.id, name: active.name, theme: active.theme, host: miniUser(active.hostId) } : null,
      job,
      lastJob,
      resources: statusCache.resources,
      queue: store.s.queue.map((q) => ({ ...q, user: miniUser(q.userId), world: store.world(q.worldId) ? { id: q.worldId, name: store.world(q.worldId).name } : null })),
    };
  }

  function start(user) {
    authorize(user, 'server.start');
    return runJob(user, 'start', 'starting the server', async (step) => {
      if (await serviceRunning()) return 'already running';
      await startActive(user, step);
      audit(user, 'server.start', store.s.server.activeWorldId);
    });
  }

  function stop(user) {
    authorize(user, 'server.stop');
    return runJob(user, 'stop', 'stopping the server', async (step) => {
      await stopServer(step);
      audit(user, 'server.stop', store.s.server.activeWorldId);
    });
  }

  function restart(user) {
    authorize(user, 'server.restart');
    checkStartable(store.activeWorld());
    return runJob(user, 'restart', 'restarting the server', async (step) => {
      await stopServer(step);
      await startActive(user, step);
      audit(user, 'server.restart', store.s.server.activeWorldId);
    });
  }

  async function consoleCommand(user, line) {
    const parsed = parseConsole(line, { mcVersion: mcVersion(), speaker: user.mcName || user.discordName });
    authorize(user, consoleAction(parsed.level));
    if ((await system.serviceState()) !== 'active') throw new HttpError(409, 'the server is not running');
    await system.sendCommand(parsed.command);
    audit(user, 'console', store.s.server.activeWorldId, { command: parsed.command.slice(0, 120) });
    return { sent: parsed.command };
  }

  async function log(user, lines = 150) {
    authorize(user, 'status.read');
    const n = Math.max(10, Math.min(500, Number(lines) || 150));
    return { lines: (await system.readLog(n)).map(redactLogLine), help: CONSOLE_HELP, gamerules: gameruleList() };
  }

  // ------------------------------------------------------------------ worlds
  function listWorlds(user) {
    authorize(user, 'worlds.read');
    return {
      worlds: store.liveWorlds().map((w) => publicWorld(w, user)),
      schema: settingsSchema(),
      themes: THEMES,
      limits: { perUser: user.role === 'owner' ? null : user.role === 'admin' ? 5 : 3 },
    };
  }

  function getWorld(user, id) {
    authorize(user, 'worlds.read');
    return { world: publicWorld(worldOr404(id), user), schema: settingsSchema() };
  }

  function createWorld(user, body = {}) {
    const name = cleanText(body.name ?? '', { field: 'name', min: 3, max: 32 });
    if (!/^[A-Za-z0-9 '!&.,_-]+$/.test(name)) throw new ValidationError('world names can use letters, digits, spaces and \' ! & . , _ -', 'name');
    if (store.liveWorlds().some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'a world with that name already exists');
    const description = cleanText(body.description ?? '', { field: 'description', max: 140 });
    const theme = THEMES.includes(body.theme) ? body.theme : 'grass';
    const settings = { ...DEFAULT_SETTINGS, motd: name.slice(0, 59), ...validateSettings(body.settings || {}, { mode: 'create' }) };
    authorize(user, 'world.create', {
      totalWorlds: store.liveWorlds().length,
      ownWorldCount: store.liveWorlds().filter((w) => w.hostId === user.id).length,
    });
    const id = newId('w', 7);
    const world = {
      id, name, description, theme, hostId: user.id, createdAt: new Date().toISOString(), createdVersion: mcVersion(), lastPlayedVersion: null,
      settings, mods: [], resourcePack: null, status: 'creating', hasData: false, playMinutes: 0,
    };
    store.mutate((s) => s.worlds.push(world));
    audit(user, 'world.create', id, { name });
    return runJob(user, 'world.create', `creating ${name}`, async (step) => {
      try {
        return await setUpNewWorld(step);
      } catch (e) {
        // Leave nothing half-made behind: drop the record and trash the folder.
        store.mutate((s) => void (s.worlds = s.worlds.filter((x) => x.id !== id)));
        await system.trashWorld(id).catch(() => {});
        throw e;
      }
    });
    async function setUpNewWorld(step) {
      const res = await system.resources();
      if (res.diskFree < 2 * 1024 ** 3) throw new Error('less than 2 GB of disk left; delete an old world or backups first');
      await system.createWorld(id);
      for (const slug of DEFAULT_MODS) {
        step(`installing ${slug}`);
        const versions = await modrinth.compatibleVersions(slug, mcVersion());
        const v = versions.find((x) => x.type === 'release') || versions[0];
        if (!v) {
          if (slug === 'easyauth') throw new Error(`EasyAuth has no build for ${mcVersion()}; a world without it would be unsafe`);
          continue;
        }
        await installVersion(user, world, v.versionId, { step, depth: 0 });
      }
      store.mutate(() => void (world.status = 'ready'));
      notify(`🌍 **${user.discordName}** created a new world: **${name}**`).catch(() => {});
      return { worldId: id };
    }
  }

  function renameWorld(user, id, body = {}) {
    const w = worldOr404(id);
    authorize(user, 'world.rename', { world: w });
    const next = {};
    if (body.name !== undefined) {
      next.name = cleanText(body.name, { field: 'name', min: 3, max: 32 });
      if (!/^[A-Za-z0-9 '!&.,_-]+$/.test(next.name)) throw new ValidationError('bad characters in name', 'name');
      if (store.liveWorlds().some((x) => x.id !== w.id && x.name.toLowerCase() === next.name.toLowerCase())) throw new HttpError(409, 'a world with that name already exists');
    }
    if (body.description !== undefined) next.description = cleanText(body.description, { field: 'description', max: 140 });
    if (body.theme !== undefined) {
      if (!THEMES.includes(body.theme)) throw new ValidationError('unknown theme');
      next.theme = body.theme;
    }
    store.mutate(() => Object.assign(w, next));
    audit(user, 'world.rename', w.id, next);
    return { world: publicWorld(w, user) };
  }

  async function updateSettings(user, id, body = {}) {
    const w = worldOr404(id);
    authorize(user, 'world.settings', { world: w });
    const changes = validateSettings(body.settings, { mode: 'update' });
    store.mutate(() => void (w.settings = { ...w.settings, ...changes }));
    const active = store.s.server.activeWorldId === w.id;
    if (active) {
      await system.writeProperties(w.settings, packFor(w));
      store.mutate((s) => void (s.server.pendingRestart = true));
    }
    audit(user, 'world.settings', w.id, changes);
    return { world: publicWorld(w, user), restartNeeded: active };
  }

  function activateWorld(user, id) {
    const w = worldOr404(id);
    const p = statusCache?.players?.online ?? 0;
    authorize(user, 'world.activate', { world: w, playersOnline: p });
    if (w.status !== 'ready') throw new HttpError(409, `${w.name} is still being set up`);
    checkStartableMods(w);
    const fromId = store.s.server.activeWorldId;
    if (fromId === w.id) throw new HttpError(409, `${w.name} is already the active world`);
    return runJob(user, 'world.activate', `switching to ${w.name}`, async (step) => {
      await stopServer(step, 30);
      step('swapping worlds');
      await system.activate(fromId, w.id);
      await system.writeProperties(w.settings, packFor(w));
      store.mutate((s) => {
        s.server.activeWorldId = w.id;
        s.server.activations.push({ worldId: w.id, at: new Date().toISOString() });
        if (s.server.activations.length > 200) s.server.activations.splice(0, s.server.activations.length - 200);
        s.queue = s.queue.filter((q) => q.worldId !== w.id);
      });
      await startActive(user, step);
      audit(user, 'world.activate', w.id, { from: fromId });
      notify(`🔀 **${user.discordName}** switched the server to **${w.name}**`).catch(() => {});
    });
  }

  function checkStartableMods(w) {
    if (!w.mods.some((m) => m.slug === 'easyauth')) throw new HttpError(409, `${w.name} has no EasyAuth; it cannot be started`);
  }

  function resetWorld(user, id, body = {}) {
    const w = worldOr404(id);
    authorize(user, 'world.reset', { world: w });
    requireConfirm(w, body.confirm);
    const seedChange = body.settings ? validateSettings(body.settings, { mode: 'create' }) : {};
    return runJob(user, 'world.reset', `resetting ${w.name}`, async (step) => {
      const active = store.s.server.activeWorldId === w.id;
      const wasRunning = active && (await serviceRunning());
      await backupWorld(w, 'prereset', step); // throws -> reset aborted
      if (active) await stopServer(step);
      step('moving the old world to trash');
      await system.resetWorld(w.id);
      store.mutate(() => {
        w.settings = { ...w.settings, ...seedChange };
        w.hasData = false;
        w.lastPlayedVersion = null;
      });
      if (active) {
        await system.writeProperties(w.settings, packFor(w));
        if (wasRunning) await startActive(user, step);
      }
      audit(user, 'world.reset', w.id);
    });
  }

  function deleteWorld(user, id, body = {}) {
    const w = worldOr404(id);
    authorize(user, 'world.delete', { world: w });
    requireConfirm(w, body.confirm);
    if (store.s.server.activeWorldId === w.id) throw new HttpError(409, 'this world is running; switch to another world before deleting it');
    return runJob(user, 'world.delete', `deleting ${w.name}`, async (step) => {
      await backupWorld(w, 'predelete', step);
      step('moving the world to trash');
      await system.trashWorld(w.id);
      store.mutate((s) => {
        w.status = 'deleted';
        w.deletedAt = new Date().toISOString();
        w.deletedBy = user.id;
        s.queue = s.queue.filter((q) => q.worldId !== w.id);
      });
      audit(user, 'world.delete', w.id, { name: w.name });
    });
  }

  // ------------------------------------------------------------------ mods
  async function modSearch(user, { q = '', offset = 0 } = {}) {
    authorize(user, 'mods.search');
    const r = await modrinth.search({ query: String(q), mcVersion: mcVersion(), offset: Number(offset) || 0 });
    return { ...r, mcVersion: mcVersion(), starterPicks: q ? [] : STARTER_PICKS };
  }

  async function modVersions(user, projectId) {
    authorize(user, 'mods.search');
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(projectId)) throw new ValidationError('bad project id');
    const [project, versions] = await Promise.all([modrinth.project(projectId), modrinth.compatibleVersions(projectId, mcVersion())]);
    return {
      project: {
        id: project.id, slug: project.slug, title: project.title, description: project.description, clientSide: project.client_side,
        serverSide: project.server_side, downloads: project.downloads, url: `https://modrinth.com/mod/${project.slug}`, license: project.license?.id,
        sourceUrl: project.source_url, issuesUrl: project.issues_url,
      },
      versions: versions.slice(0, 15),
      mcVersion: mcVersion(),
    };
  }

  /** Install one Modrinth version (and its required dependencies) into a world. */
  async function installVersion(user, world, versionId, { step, depth, chain = new Set() }) {
    if (depth > 3 || chain.size > 8) throw new Error('too many nested dependencies');
    const version = await modrinth.version(versionId);
    const project = await modrinth.project(version.project_id);
    const file = assertInstallable(project, version, mcVersion());
    chain.add(project.id);
    const installed = [];

    for (const dep of version.dependencies || []) {
      if (dep.dependency_type !== 'required' || !dep.project_id || chain.has(dep.project_id)) continue;
      if (world.mods.some((m) => m.projectId === dep.project_id)) continue;
      let depVersionId = dep.version_id;
      if (!depVersionId) {
        const vs = await modrinth.compatibleVersions(dep.project_id, mcVersion());
        const v = vs.find((x) => x.type === 'release') || vs[0];
        if (!v) throw new Error(`"${project.title}" needs a mod that has no ${mcVersion()} build`);
        depVersionId = v.versionId;
      }
      installed.push(...(await installVersion(user, world, depVersionId, { step, depth: depth + 1, chain })));
    }

    step?.(`downloading ${project.title} (checking sha512)`);
    const bytes = await modrinth.download(file);
    const filename = `${project.slug}--${String(version.version_number).replace(/[^A-Za-z0-9._+-]/g, '_')}.jar`.slice(0, 128);
    const old = world.mods.find((m) => m.projectId === project.id || m.slug === project.slug);
    if (old && old.filename !== filename) await system.removeMod(world.id, old.filename);
    await system.installMod(world.id, filename, bytes, file.hashes.sha512);
    const record = {
      projectId: project.id,
      slug: project.slug,
      title: project.title,
      versionId: version.id,
      versionNumber: version.version_number,
      gameVersions: version.game_versions,
      filename,
      sha512: file.hashes.sha512,
      size: bytes.length,
      clientSide: project.client_side,
      serverSide: project.server_side,
      iconUrl: project.icon_url && /^https:\/\/cdn\.modrinth\.com\//.test(project.icon_url) ? project.icon_url : null,
      requires: (version.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id),
      protected: Object.hasOwn(PROTECTED_MODS, project.slug),
      addedBy: user?.id ?? null,
      addedAt: new Date().toISOString(),
    };
    store.mutate(() => {
      world.mods = world.mods.filter((m) => m.projectId !== project.id && m.slug !== project.slug);
      world.mods.push(record);
    });
    installed.push(record);
    return installed;
  }

  function installMod(user, worldId, body = {}) {
    const w = worldOr404(worldId);
    authorize(user, 'mods.manage', { world: w });
    if (!MODRINTH_ID_RE.test(String(body.versionId || ''))) throw new ValidationError('pick a version to install');
    return runJob(user, 'mods.install', `installing a mod on ${w.name}`, async (step) => {
      const installed = await installVersion(user, w, body.versionId, { step, depth: 0 });
      if (store.s.server.activeWorldId === w.id) store.mutate((s) => void (s.server.pendingRestart = true));
      audit(user, 'mods.install', w.id, { mods: installed.map((m) => `${m.slug}@${m.versionNumber}`) });
      return { installed: installed.map((m) => ({ title: m.title, versionNumber: m.versionNumber, clientSide: m.clientSide })) };
    });
  }

  function removeMod(user, worldId, projectId) {
    const w = worldOr404(worldId);
    authorize(user, 'mods.manage', { world: w });
    const mod = w.mods.find((m) => m.projectId === projectId || (!m.projectId && m.slug === projectId));
    if (!mod) throw new HttpError(404, 'that mod is not installed');
    if (Object.hasOwn(PROTECTED_MODS, mod.slug)) throw new HttpError(400, `${mod.title || mod.slug} can't be removed: ${PROTECTED_MODS[mod.slug]}`);
    const dependents = w.mods.filter((m) => m.requires?.includes(mod.projectId));
    if (dependents.length) throw new HttpError(409, `remove these first, they need it: ${dependents.map((d) => d.title).join(', ')}`);
    return runJob(user, 'mods.remove', `removing ${mod.title || mod.slug}`, async (step) => {
      await backupWorld(w, 'premodremove', step);
      await system.removeMod(w.id, mod.filename);
      store.mutate((s) => {
        w.mods = w.mods.filter((m) => m !== mod);
        if (s.server.activeWorldId === w.id) s.server.pendingRestart = true;
      });
      audit(user, 'mods.remove', w.id, { mod: mod.slug });
    });
  }

  // ------------------------------------------------------------------ resource packs
  function packTicket(user, worldId) {
    const w = worldOr404(worldId);
    authorize(user, 'pack.manage', { world: w });
    for (const [t, v] of tickets) if (v.exp < Date.now()) tickets.delete(t);
    const token = randomToken(32);
    tickets.set(token, { userId: user.id, worldId: w.id, exp: Date.now() + TICKET_TTL_MS });
    return { uploadUrl: `${config.publicUrl.replace(/\/$/, '')}/v1/uploads/${token}`, maxBytes: PACK_LIMITS.maxBytes, expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString() };
  }

  /** Called by the unauthenticated upload route; the ticket is the credential. */
  async function uploadPack(token, buf, filename) {
    const t = tickets.get(token);
    tickets.delete(token); // single use, even if it fails
    if (!t || t.exp < Date.now()) throw new HttpError(401, 'upload link expired; try again');
    const user = store.user(t.userId);
    const w = worldOr404(t.worldId);
    authorize(user, 'pack.manage', { world: w });
    const info = inspectPack(buf);
    await system.storePack(info.sha1, buf);
    const name = typeof filename === 'string' ? filename.replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 64) : 'pack.zip';
    store.mutate(() => void (w.resourcePack = { sha1: info.sha1, size: info.size, files: info.entries, name, uploadedBy: user.id, at: new Date().toISOString() }));
    if (store.s.server.activeWorldId === w.id) {
      await system.writeProperties(w.settings, packFor(w));
      store.mutate((s) => void (s.server.pendingRestart = true));
    }
    audit(user, 'pack.upload', w.id, { sha1: info.sha1, size: info.size });
    return { resourcePack: { ...w.resourcePack, url: packUrl(info.sha1) } };
  }

  async function removePack(user, worldId) {
    const w = worldOr404(worldId);
    authorize(user, 'pack.manage', { world: w });
    store.mutate(() => void (w.resourcePack = null));
    if (store.s.server.activeWorldId === w.id) {
      await system.writeProperties(w.settings, null);
      store.mutate((s) => void (s.server.pendingRestart = true));
    }
    audit(user, 'pack.remove', w.id);
    return { ok: true };
  }

  function isKnownPack(sha1) {
    return store.s.worlds.some((w) => w.resourcePack?.sha1 === sha1);
  }

  // ------------------------------------------------------------------ backups
  function attribute(file, mtime) {
    const m = BACKUP_RE.exec(file);
    if (!m) return null;
    const at = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`;
    const tag = m[3];
    const tm = /^([a-z0-9]{3,24})_([a-z]+)$/.exec(tag);
    if (tm) return { worldId: tm[1], kind: tm[2], at };
    // Timer ("auto") and SSH backups: belong to whichever world was active at the time.
    const acts = store.s.server.activations;
    let worldId = acts.length ? null : store.s.worlds[0]?.id ?? null;
    for (const a of acts) if (a.at <= at) worldId = a.worldId;
    if (!worldId && acts.length) worldId = store.s.worlds[0]?.id ?? null;
    return { worldId, kind: tag, at: at || mtime };
  }

  async function listBackups(user, worldId) {
    authorize(user, 'backups.read');
    const files = await system.listBackups();
    const list = files
      .map((f) => ({ id: f.file, size: f.size, ...attribute(f.file, f.mtime) }))
      .filter((b) => b.worldId && (!worldId || b.worldId === worldId))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return { backups: list };
  }

  function backupNow(user, worldId) {
    const w = worldOr404(worldId);
    authorize(user, 'backup.create', { world: w });
    return runJob(user, 'backup', `backing up ${w.name}`, async (step) => {
      const active = store.s.server.activeWorldId === w.id;
      if (!active && !w.hasData) throw new Error('this world has never been played, nothing to back up yet');
      step('saving and archiving');
      const file = await system.backup(w.id, 'manual');
      audit(user, 'backup.create', w.id, { file });
      return { file };
    });
  }

  async function restoreBackup(user, worldId, body = {}) {
    const w = worldOr404(worldId);
    authorize(user, 'world.restore', { world: w });
    requireConfirm(w, body.confirm);
    const { backups } = await listBackups(user, w.id);
    const b = backups.find((x) => x.id === body.backupId);
    if (!b) throw new HttpError(404, 'that backup does not belong to this world');
    return runJob(user, 'world.restore', `restoring ${w.name}`, async (step) => {
      const active = store.s.server.activeWorldId === w.id;
      const wasRunning = active && (await serviceRunning());
      await backupWorld(w, 'prerestore', step);
      if (active) await stopServer(step);
      step('restoring the backup');
      await system.restore(w.id, b.id);
      store.mutate(() => void (w.hasData = true));
      if (wasRunning) await startActive(user, step);
      audit(user, 'world.restore', w.id, { backup: b.id });
    });
  }

  // ------------------------------------------------------------------ queue
  function joinQueue(user, { worldId, note = '' } = {}) {
    authorize(user, 'queue.join');
    const w = worldOr404(worldId);
    const entry = { id: newId('q', 8), userId: user.id, worldId: w.id, note: cleanText(note, { field: 'note', max: 80 }), at: new Date().toISOString() };
    store.mutate((s) => {
      s.queue = s.queue.filter((q) => q.userId !== user.id);
      s.queue.push(entry);
    });
    audit(user, 'queue.join', w.id);
    return { entry };
  }

  function leaveQueue(user, entryId) {
    const e = store.s.queue.find((q) => q.id === entryId);
    if (!e) throw new HttpError(404, 'not in the queue');
    if (e.userId !== user.id) authorize(user, 'queue.manage');
    store.mutate((s) => void (s.queue = s.queue.filter((q) => q.id !== entryId)));
    audit(user, 'queue.leave', e.worldId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ audit
  function readAudit(user, limit = 100) {
    authorize(user, 'audit.read');
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return { entries: store.readAudit(n).map((e) => ({ ...e, actorUser: e.actor?.startsWith?.('u') ? miniUser(e.actor) : null })) };
  }

  /** A friendly activity feed for everyone: only harmless, non-denied events. */
  function activity(user) {
    authorize(user, 'status.read');
    const keep = new Set(['server.start', 'server.stop', 'server.restart', 'world.create', 'world.activate', 'mods.install', 'mods.remove', 'pack.upload', 'backup.create', 'world.reset', 'world.restore', 'auth.join', 'users.whitelist']);
    const entries = store
      .readAudit(300)
      .filter((e) => e.result === 'ok' && keep.has(e.action))
      .slice(0, 25)
      .map((e) => ({ ts: e.ts, action: e.action, actor: miniUser(e.actor), world: e.target && store.s.worlds.find((w) => w.id === e.target) ? { id: e.target, name: store.s.worlds.find((w) => w.id === e.target).name } : null }));
    return { entries };
  }

  return {
    init, login, resolveActor, me, listUsers, updateUser, setMcName, whitelistUser, logoutAll,
    listInvites, createInvite, revokeInvite, status, start, stop, restart, consoleCommand, log,
    listWorlds, getWorld, createWorld, renameWorld, updateSettings, activateWorld, resetWorld, deleteWorld,
    modSearch, modVersions, installMod, removeMod, packTicket, uploadPack, removePack, isKnownPack,
    listBackups, backupNow, restoreBackup, joinQueue, leaveQueue, readAudit, activity,
    _jobs: () => ({ job, lastJob }),
  };
}

/** Hide player IPs and anything typed after an auth command before logs leave the VM. */
export function redactLogLine(line) {
  return String(line)
    .replace(/\b(\d{1,3}\.){3}\d{1,3}(:\d+)?\b/g, '‹ip›')
    .replace(/\[[0-9a-fA-F:]{6,}\](:\d+)?/g, '‹ip›')
    .replace(/(\/(?:login|l|register|reg|changepassword|changepw|account)\b)[^\n]*/gi, '$1 ‹hidden›')
    .slice(0, 600);
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));
