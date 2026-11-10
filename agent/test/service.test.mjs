// Authorisation and workflow tests: the real service + HTTP layer, the mock VM and fake Modrinth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createMockSystem } from '../src/system-mock.mjs';
import { signHeaders } from '../src/hmac.mjs';
import { RATE_CLASSES } from '../src/ratelimit.mjs';
import { buildZip } from '../src/zip.mjs';
import { decide, ACTIONS } from '../src/policy.mjs';
import { createFakeModrinth } from './fixtures/fake-modrinth.mjs';

const KEY = crypto.randomBytes(32);
const OWNER_DISCORD = '200000000000000001';
let server, base, svc, store, system, modrinth;
const users = {};

async function call(method, p, { as, body, actor } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const who = actor ?? `user:${as.id}:${store.user(as.id).epoch}`;
  const headers = { ...signHeaders({ kid: 'k1', key: KEY, method, path: p, actor: who, body: raw }), ...(raw ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(base + p, { method, headers, body: raw || undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitJob() {
  for (let i = 0; i < 400; i++) {
    const { job, lastJob } = svc._jobs();
    if (!job) return lastJob;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

async function login(discordId, inviteCode) {
  const r = await call('POST', '/v1/auth/login', { actor: 'system:login', body: { discordId, discordName: `d${discordId.slice(-3)}`, inviteCode } });
  return r;
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopon-test-'));
  store = new Store(null);
  system = createMockSystem({ dataDir, speed: 200 });
  modrinth = createFakeModrinth();
  const config = { mode: 'mock', publicUrl: 'http://127.0.0.1:1', dashboardOrigin: 'http://localhost:3000', ownerDiscordId: OWNER_DISCORD, joinAddress: 'x', mcVersion: '26.3', mockSpeedup: true, packFile: (s) => system.packFile(s) };
  svc = createService({ store, system, modrinth, config });
  await svc.init();
  // The adopted world needs EasyAuth to start; give it the defaults via the real install path.
  server = createHttpServer({ svc, keys: new Map([['k1', KEY]]), config, log: {}, rateClasses: { ...RATE_CLASSES, heavy: { capacity: 40, refillPerSec: 0.01 } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
});

after(() => {
  server.close();
  system.close();
});

// ---------------------------------------------------------------- policy table (pure)
test('policy: every action has a rule, and disabled users can do nothing', () => {
  const disabled = { id: 'u1', role: 'owner', status: 'disabled' };
  for (const action of Object.keys(ACTIONS)) assert.equal(decide(disabled, action).allow, false, action);
  assert.equal(decide({ id: 'u1', role: 'owner', status: 'active' }, 'nope').allow, false);
});

test('policy: hosts manage their own world, not others', () => {
  const host = { id: 'h', role: 'member', status: 'active' };
  const other = { id: 'o', role: 'member', status: 'active' };
  const admin = { id: 'a', role: 'admin', status: 'active' };
  const owner = { id: 'w', role: 'owner', status: 'active' };
  const world = { id: 'w1', hostId: 'h' };
  for (const a of ['world.settings', 'mods.manage', 'pack.manage', 'backup.create', 'world.delete', 'world.reset', 'world.restore', 'world.activate']) {
    assert.equal(decide(host, a, { world }).allow, true, `host ${a}`);
    assert.equal(decide(other, a, { world }).allow, false, `other ${a}`);
  }
  // Admins help with day-to-day things but not the sensitive ones; the owner can do both.
  assert.equal(decide(admin, 'mods.manage', { world }).allow, true);
  assert.equal(decide(admin, 'world.delete', { world }).allow, false);
  assert.equal(decide(owner, 'world.delete', { world }).allow, true);
  assert.equal(decide(admin, 'users.manage').allow, false);
  assert.equal(decide(admin, 'invites.manage').allow, false);
});

test('policy: only the running world\'s host or an admin can stop it or use host commands', () => {
  const activeWorld = { id: 'w1', hostId: 'h' };
  assert.equal(decide({ id: 'h', role: 'member', status: 'active' }, 'server.stop', { activeWorld }).allow, true);
  assert.equal(decide({ id: 'x', role: 'member', status: 'active' }, 'server.stop', { activeWorld }).allow, false);
  assert.equal(decide({ id: 'x', role: 'member', status: 'active' }, 'console.host', { activeWorld }).allow, false);
  assert.equal(decide({ id: 'x', role: 'member', status: 'active' }, 'console.basic', { activeWorld }).allow, true);
  assert.equal(decide({ id: 'a', role: 'admin', status: 'active' }, 'server.restart', { activeWorld }).allow, true);
});

test('policy: switching away from a busy world needs its host; quotas apply', () => {
  const me = { id: 'm', role: 'member', status: 'active' };
  const activeWorld = { id: 'w1', hostId: 'h' };
  const mine = { id: 'w2', hostId: 'm' };
  assert.equal(decide(me, 'world.activate', { world: mine, activeWorld, playersOnline: 0 }).allow, true);
  assert.match(decide(me, 'world.activate', { world: mine, activeWorld, playersOnline: 2 }).reason, /queue/);
  assert.equal(decide({ id: 'h', role: 'member', status: 'active' }, 'world.activate', { world: { id: 'w3', hostId: 'h' }, activeWorld, playersOnline: 2 }).allow, true);
  assert.match(decide(me, 'world.create', { ownWorldCount: 3, totalWorlds: 4 }).reason, /up to 3/);
  assert.match(decide({ ...me, role: 'owner' }, 'world.create', { ownWorldCount: 50, totalWorlds: 12 }).reason, /already has 12/);
});

// ---------------------------------------------------------------- login & invites
test('login: strangers are refused, the owner is bootstrapped as Team Leader', async () => {
  const stranger = await login('300000000000000009');
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error, /invite-only/);
  const owner = await login(OWNER_DISCORD);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.user.role, 'owner');
  assert.equal(owner.body.user.title, 'Team Leader');
  users.owner = owner.body.user;
  assert.equal(store.world('hopon').hostId, users.owner.id, 'owner claims the adopted world');
});

test('invites: single use, member cannot create them, code is stored hashed', async () => {
  const inv = await call('POST', '/v1/invites', { as: users.owner, body: { title: 'Pro Cave Explorer', titleTier: 'rare' } });
  assert.equal(inv.status, 200);
  assert.ok(!JSON.stringify(store.s.invites).includes(inv.body.code), 'raw code not stored');
  const m = await login('300000000000000001', inv.body.code);
  assert.equal(m.status, 200);
  assert.equal(m.body.user.title, 'Pro Cave Explorer');
  users.member = m.body.user;
  const reuse = await login('300000000000000002', inv.body.code);
  assert.equal(reuse.status, 403);

  const inv2 = await call('POST', '/v1/invites', { as: users.owner, body: { role: 'admin', title: 'Redstone Wizard', titleTier: 'epic' } });
  users.admin = (await login('300000000000000003', inv2.body.code)).body.user;
  const inv3 = await call('POST', '/v1/invites', { as: users.owner, body: {} });
  users.member2 = (await login('300000000000000004', inv3.body.code)).body.user;

  const denied = await call('POST', '/v1/invites', { as: users.member, body: {} });
  assert.equal(denied.status, 403);
  assert.equal((await call('POST', '/v1/invites', { as: users.admin, body: {} })).status, 403);
});

test('auth: wrong actor for login, unsigned and replayed requests are rejected', async () => {
  assert.equal((await call('POST', '/v1/auth/login', { as: users.owner, body: { discordId: OWNER_DISCORD } })).status, 403);
  assert.equal((await call('GET', '/v1/me', { actor: 'system:login' })).status, 403);
  assert.equal((await fetch(base + '/v1/status')).status, 401);
  const headers = signHeaders({ kid: 'k1', key: KEY, method: 'GET', path: '/v1/me', actor: `user:${users.owner.id}:1` });
  assert.equal((await fetch(base + '/v1/me', { headers })).status, 200);
  assert.equal((await fetch(base + '/v1/me', { headers })).status, 401, 'replay');
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('auth: logout-all and disabling a user revoke their sessions at once', async () => {
  const old = { ...users.member2 };
  assert.equal((await call('GET', '/v1/me', { as: old })).status, 200);
  const staleActor = `user:${old.id}:${store.user(old.id).epoch}`;
  assert.equal((await call('POST', '/v1/users/me/logout-all', { as: old })).status, 200);
  assert.equal((await call('GET', '/v1/me', { actor: staleActor })).status, 401);
  const dis = await call('PATCH', `/v1/users/${old.id}`, { as: users.owner, body: { status: 'disabled' } });
  assert.equal(dis.status, 200);
  assert.equal((await call('GET', '/v1/me', { as: old })).status, 403);
  assert.equal((await login('300000000000000004')).status, 403);
  assert.equal((await call('PATCH', `/v1/users/${users.owner.id}`, { as: users.owner, body: { status: 'disabled' } })).status, 400, 'cannot lock yourself out');
  assert.equal((await call('PATCH', `/v1/users/${users.member.id}`, { as: users.admin, body: { role: 'admin' } })).status, 403);
  assert.equal((await call('PATCH', `/v1/users/${users.member.id}`, { as: users.owner, body: { role: 'owner' } })).status, 400);
});

// ---------------------------------------------------------------- worlds
test('worlds: a member creates a world with the protected mods and becomes its host', async () => {
  const r = await call('POST', '/v1/worlds', { as: users.member, body: { name: 'Cave Town', theme: 'snow', settings: { difficulty: 'hard', 'level-seed': '42' } } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const done = await waitJob();
  assert.equal(done.ok, true, done.error);
  const w = store.world(done.result.worldId);
  users.memberWorld = w.id;
  assert.equal(w.hostId, users.member.id);
  assert.deepEqual(w.mods.map((m) => m.slug).sort(), ['easyauth', 'fabric-api', 'ferrite-core', 'lithium']);
  assert.equal(w.settings['level-seed'], '42');
});

test('worlds: create rejects security keys and bad names', async () => {
  const r = await call('POST', '/v1/worlds', { as: users.member, body: { name: 'Hack', settings: { 'online-mode': true } } });
  assert.equal(r.status, 400);
  assert.equal((await call('POST', '/v1/worlds', { as: users.member, body: { name: '<script>' } })).status, 400);
});

test('worlds: other members cannot change, reset or delete someone else\'s world', async () => {
  const id = users.memberWorld;
  const inv = await call('POST', '/v1/invites', { as: users.owner, body: {} });
  users.other = (await login('300000000000000005', inv.body.code)).body.user;
  for (const [m, p, b] of [
    ['PATCH', `/v1/worlds/${id}/settings`, { settings: { pvp: false } }],
    ['PATCH', `/v1/worlds/${id}`, { name: 'Mine Now' }],
    ['POST', `/v1/worlds/${id}/reset`, { confirm: 'Cave Town' }],
    ['POST', `/v1/worlds/${id}/delete`, { confirm: 'Cave Town' }],
    ['POST', `/v1/worlds/${id}/mods`, { versionId: modrinth.versionIdFor('chunky') }],
    ['POST', `/v1/worlds/${id}/pack-ticket`, {}],
    ['POST', `/v1/worlds/${id}/backups`, {}],
    ['POST', `/v1/worlds/${id}/activate`, {}],
  ]) {
    const r = await call(m, p, { as: users.other, body: b });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  // Admin can help with settings but not destroy it.
  assert.equal((await call('PATCH', `/v1/worlds/${id}/settings`, { as: users.admin, body: { settings: { pvp: false } } })).status, 200);
  assert.equal((await call('POST', `/v1/worlds/${id}/delete`, { as: users.admin, body: { confirm: 'Cave Town' } })).status, 403);
  // Denials are audited.
  assert.ok(store.readAudit(200).some((e) => e.result === 'denied' && e.actor === users.other.id));
});

test('worlds: settings edits only accept allowlisted keys', async () => {
  const id = users.memberWorld;
  const ok = await call('PATCH', `/v1/worlds/${id}/settings`, { as: users.member, body: { settings: { difficulty: 'easy', 'max-players': 6 } } });
  assert.equal(ok.status, 200);
  for (const s of [{ 'enable-rcon': true }, { 'level-seed': '7' }, { 'view-distance': 64 }, { motd: 'a\nb' }]) {
    assert.equal((await call('PATCH', `/v1/worlds/${id}/settings`, { as: users.member, body: { settings: s } })).status, 400, JSON.stringify(s));
  }
});

test('mods: install resolves required deps; client-only mods are refused; protected mods stay', async () => {
  const id = users.memberWorld;
  const r = await call('POST', `/v1/worlds/${id}/mods`, { as: users.member, body: { versionId: modrinth.versionIdFor('universal-graves') } });
  assert.equal(r.status, 202);
  const j = await waitJob();
  assert.equal(j.ok, true, j.error);
  const slugs = store.world(id).mods.map((m) => m.slug);
  assert.ok(slugs.includes('universal-graves') && slugs.includes('cloth-config'), 'dependency installed');

  await call('POST', `/v1/worlds/${id}/mods`, { as: users.member, body: { versionId: modrinth.versionIdFor('iris') } });
  const iris = await waitJob();
  assert.equal(iris.ok, false);
  assert.match(iris.error, /players' own computers/);

  const ea = store.world(id).mods.find((m) => m.slug === 'easyauth');
  const rm = await call('DELETE', `/v1/worlds/${id}/mods/${ea.projectId}`, { as: users.member });
  assert.equal(rm.status, 400);
  assert.match(rm.body.error, /can't be removed/);
  const cloth = store.world(id).mods.find((m) => m.slug === 'cloth-config');
  assert.equal((await call('DELETE', `/v1/worlds/${id}/mods/${cloth.projectId}`, { as: users.member })).status, 409, 'graves needs it');
});

test('mods: a tampered download (sha512 mismatch) is not installed', async () => {
  const bad = createFakeModrinth({ overrides: { chunky: { badHash: true } } });
  const before = store.world(users.memberWorld).mods.length;
  const svc2 = createService({ store, system, modrinth: bad, config: { mode: 'mock', publicUrl: base, ownerDiscordId: OWNER_DISCORD, mcVersion: '26.3', mockSpeedup: true } });
  svc2.installMod(store.user(users.member.id), users.memberWorld, { versionId: bad.versionIdFor('chunky') });
  let last;
  for (let i = 0; i < 200 && !(last = svc2._jobs().lastJob); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(last.ok, false);
  assert.match(last.error, /checksum mismatch/);
  assert.equal(store.world(users.memberWorld).mods.length, before);
});

test('mods: removing a mod takes a backup first', async () => {
  const id = users.memberWorld;
  store.mutate(() => void (store.world(id).hasData = true));
  const before = (await system.listBackups()).length;
  const lith = store.world(id).mods.find((m) => m.slug === 'lithium');
  assert.equal((await call('DELETE', `/v1/worlds/${id}/mods/${lith.projectId}`, { as: users.member })).status, 202);
  assert.equal((await waitJob()).ok, true);
  const after = await system.listBackups();
  assert.equal(after.length, before + 1);
  assert.match(after.at(-1).file, new RegExp(`-${id}_premodremove\\.tar\\.gz$`));
});

test('destructive actions need the world name typed, and back up first', async () => {
  const id = users.memberWorld;
  assert.equal((await call('POST', `/v1/worlds/${id}/delete`, { as: users.member, body: { confirm: 'cave town' } })).status, 400);
  assert.equal((await call('POST', `/v1/worlds/${id}/reset`, { as: users.member, body: {} })).status, 400);
  const n = (await system.listBackups()).length;
  assert.equal((await call('POST', `/v1/worlds/${id}/reset`, { as: users.member, body: { confirm: 'Cave Town', settings: { 'level-seed': '99' } } })).status, 202);
  assert.equal((await waitJob()).ok, true);
  const list = await system.listBackups();
  assert.equal(list.length, n + 1);
  assert.match(list.at(-1).file, /_prereset\.tar\.gz$/);
  assert.equal(store.world(id).settings['level-seed'], '99');
});

test('the running world cannot be deleted; switching works and protects EasyAuth', async () => {
  const hop = store.world('hopon');
  assert.equal((await call('POST', '/v1/worlds/hopon/delete', { as: users.owner, body: { confirm: hop.name } })).status, 409);
  // The adopted world has no mods recorded in this test, so it cannot start without EasyAuth.
  assert.equal((await call('POST', '/v1/server/start', { as: users.owner })).status, 202);
  const j = await waitJob();
  assert.equal(j.ok, false);
  assert.match(j.error, /EasyAuth/);
  // People are playing on someone else's world: a member may not switch, even when nobody has
  // had the dashboard open (so no cached status exists). The agent asks the server itself.
  const realPing = system.ping;
  system.ping = async () => ({ online: 2, max: 10, sample: ['a', 'b'] });
  const blocked = await call('POST', `/v1/worlds/${users.memberWorld}/activate`, { as: users.member });
  system.ping = realPing;
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /queue/);
  // The member switches to their own world (nobody online).
  const sw =await call('POST', `/v1/worlds/${users.memberWorld}/activate`, { as: users.member });
  assert.equal(sw.status, 202, JSON.stringify(sw.body));
  const done = await waitJob();
  assert.equal(done.ok, true, done.error);
  assert.equal(store.s.server.activeWorldId, users.memberWorld);
  assert.equal(await system.serviceState(), 'active');
  assert.match(system._debug.props, /^online-mode=false$/m);
  assert.match(system._debug.props, /^difficulty=easy$/m);
});

test('console: members get basic commands, host commands need the running world\'s host', async () => {
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await call('POST', '/v1/server/console', { as: users.other, body: { command: 'say hi' } })).status, 200);
  assert.equal((await call('POST', '/v1/server/console', { as: users.other, body: { command: 'time set day' } })).status, 403);
  assert.equal((await call('POST', '/v1/server/console', { as: users.member, body: { command: 'time set day' } })).status, 200);
  assert.equal((await call('POST', '/v1/server/console', { as: users.member, body: { command: 'op Zbeast' } })).status, 400);
  assert.equal((await call('POST', '/v1/server/console', { as: users.member, body: { command: 'whitelist list' } })).status, 403);
  assert.equal((await call('POST', '/v1/server/console', { as: users.admin, body: { command: 'whitelist list' } })).status, 200);
  assert.equal((await call('POST', '/v1/server/stop', { as: users.other })).status, 403);
});

test('resource packs: ticketed upload, single use, CORS-locked, validated', async () => {
  const id = users.memberWorld;
  const t = await call('POST', `/v1/worlds/${id}/pack-ticket`, { as: users.member });
  assert.equal(t.status, 200);
  const zip = buildZip({ 'pack.mcmeta': '{"pack":{"pack_format":60,"description":"x"}}', 'assets/a.png': 'png' });
  const bad = await fetch(t.body.uploadUrl, { method: 'PUT', body: zip, headers: { origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  const ok = await fetch(t.body.uploadUrl, { method: 'PUT', body: zip, headers: { origin: 'http://localhost:3000', 'x-file-name': 'cool pack.zip' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const { resourcePack } = await ok.json();
  assert.match(system._debug.props, new RegExp(`^resource-pack-sha1=${resourcePack.sha1}$`, 'm'));
  const again = await fetch(t.body.uploadUrl, { method: 'PUT', body: zip, headers: { origin: 'http://localhost:3000' } });
  assert.equal(again.status, 401, 'ticket is single use');
  const served = await fetch(`${base}/packs/${resourcePack.sha1}.zip`);
  assert.equal(served.status, 200);
  assert.equal(Buffer.from(await served.arrayBuffer()).length, zip.length);
  assert.equal((await fetch(`${base}/packs/${'b'.repeat(40)}.zip`)).status, 404);

  const t2 = await call('POST', `/v1/worlds/${id}/pack-ticket`, { as: users.member });
  const evil = buildZip({ 'pack.mcmeta': '{}', '../../etc/cron.d/x': 'boom' });
  const r = await fetch(t2.body.uploadUrl, { method: 'PUT', body: evil, headers: { origin: 'http://localhost:3000' } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unsafe file/);
});

test('whitelisting goes through the offline-UUID helper and needs an admin', async () => {
  assert.equal((await call('POST', '/v1/users/me/mc-name', { as: users.member, body: { mcName: 'Zbeast' } })).status, 200);
  assert.equal((await call('POST', '/v1/users/me/mc-name', { as: users.other, body: { mcName: 'zbeast' } })).status, 409, 'case-insensitive clash');
  assert.equal((await call('POST', '/v1/users/me/mc-name', { as: users.other, body: { mcName: 'bad name!' } })).status, 400);
  assert.equal((await call('POST', `/v1/users/${users.member.id}/whitelist`, { as: users.other })).status, 403);
  const r = await call('POST', `/v1/users/${users.member.id}/whitelist`, { as: users.admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.mcStatus, 'whitelisted');
  assert.equal(r.body.user.offlineUuid.length, 36);
});

test('audit log is admin-only and records actions', async () => {
  assert.equal((await call('GET', '/v1/audit', { as: users.member })).status, 403);
  const r = await call('GET', '/v1/audit?limit=50', { as: users.owner });
  assert.equal(r.status, 200);
  const actions = new Set(r.body.entries.map((e) => e.action));
  for (const a of ['world.create', 'mods.install', 'world.activate', 'pack.upload', 'users.whitelist']) assert.ok(actions.has(a), a);
});

test('rate limits: heavy actions are throttled per user', async () => {
  let last;
  for (let i = 0; i < 45; i++) last = await call('POST', `/v1/worlds/${users.memberWorld}/backups`, { as: users.other });
  assert.equal(last.status, 429);
});
