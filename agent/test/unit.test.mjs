// Unit tests: signing, allowlists, validators, zip checks, Modrinth checks, rate limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyRequest, signHeaders, NonceCache, parseKeys } from '../src/hmac.mjs';
import { validateSettings, renderProperties, ENFORCED } from '../src/properties.mjs';
import { parseConsole } from '../src/console.mjs';
import { offlineUuid, compareVersions, cleanText } from '../src/validate.mjs';
import { inspectPack, buildZip, badPath } from '../src/zip.mjs';
import { assertInstallable, checkFile, createModrinth } from '../src/modrinth.mjs';
import { RateLimiter } from '../src/ratelimit.mjs';
import { redactLogLine } from '../src/service.mjs';

const KEY = crypto.randomBytes(32);
const keys = new Map([['k1', KEY]]);
const actor = 'user:u0abcdef12:1';

function signed({ method = 'POST', path = '/v1/server/start', body = '{}', now = Date.now(), who = actor, key = KEY, kid = 'k1' } = {}) {
  return { headers: signHeaders({ kid, key, method, path, actor: who, body, now }), method, path, rawBody: Buffer.from(body), now };
}

// ---------------------------------------------------------------- HMAC
test('hmac: a correctly signed request verifies', () => {
  const r = signed();
  const v = verifyRequest({ keys, nonces: new NonceCache(), ...r });
  assert.deepEqual(v, { ok: true, actor });
});

test('hmac: tampered body, path, method or actor is rejected', () => {
  for (const tweak of [
    (r) => (r.rawBody = Buffer.from('{"x":1}')),
    (r) => (r.path = '/v1/server/stop'),
    (r) => (r.method = 'DELETE'),
    (r) => (r.headers['x-hop-actor'] = 'user:u0owner000:1'),
  ]) {
    const r = signed();
    tweak(r);
    assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...r }).ok, false);
  }
});

test('hmac: wrong key, unknown kid and missing headers are rejected', () => {
  assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...signed({ key: crypto.randomBytes(32) }) }).reason, 'bad signature');
  assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...signed({ kid: 'k9' }) }).reason, 'unknown key id');
  const r = signed();
  delete r.headers['x-hop-sig'];
  assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...r }).ok, false);
});

test('hmac: stale or future timestamps are rejected', () => {
  const r = signed({ now: Date.now() - 120_000 });
  assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...r, now: Date.now() }).reason, 'stale timestamp');
  const f = signed({ now: Date.now() + 120_000 });
  assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...f, now: Date.now() }).reason, 'stale timestamp');
});

test('hmac: replaying the same request is rejected', () => {
  const nonces = new NonceCache();
  const r = signed();
  assert.equal(verifyRequest({ keys, nonces, ...r }).ok, true);
  assert.equal(verifyRequest({ keys, nonces, ...r }).reason, 'replayed nonce');
});

test('hmac: actors must be well-formed', () => {
  for (const who of ['user:../etc:1', 'system:root', 'user:u0abcdef12', 'admin']) {
    assert.equal(verifyRequest({ keys, nonces: new NonceCache(), ...signed({ who }) }).reason, 'bad actor');
  }
});

test('hmac: key parsing enforces length and format', () => {
  assert.throws(() => parseKeys(''), /no HMAC keys/);
  assert.throws(() => parseKeys(`k1:${crypto.randomBytes(16).toString('base64')}`), /shorter than 32/);
  assert.equal(parseKeys(`a:${crypto.randomBytes(32).toString('base64')},b:${crypto.randomBytes(32).toString('base64')}`).size, 2);
});

// ---------------------------------------------------------------- server.properties allowlist
test('properties: allowlisted keys validate and coerce', () => {
  assert.deepEqual(validateSettings({ difficulty: 'hard', 'max-players': '8', pvp: 'false' }), { difficulty: 'hard', 'max-players': 8, pvp: false });
});

test('properties: security keys can never be set from the dashboard', () => {
  for (const key of ['online-mode', 'white-list', 'enforce-whitelist', 'enable-rcon', 'rcon.password', 'enable-query', 'management-server-enabled', 'level-name', 'server-port', 'resource-pack', 'op-permission-level']) {
    assert.throws(() => validateSettings({ [key]: 'true' }), /not a setting/, key);
  }
});

test('properties: ranges, enums and create-only keys are enforced', () => {
  assert.throws(() => validateSettings({ 'view-distance': 32 }), /3 to 12/);
  assert.throws(() => validateSettings({ difficulty: 'nightmare' }), /one of/);
  assert.throws(() => validateSettings({ 'level-seed': '123' }), /created or reset/);
  assert.deepEqual(validateSettings({ 'level-seed': '123' }, { mode: 'create' }), { 'level-seed': '123' });
});

test('properties: newline injection in text values is rejected', () => {
  assert.throws(() => validateSettings({ motd: 'hi\nonline-mode=true' }), /control characters/);
  assert.throws(() => validateSettings({ motd: 'x'.repeat(60) }), /at most 59/);
});

test('properties: rendering forces enforced keys and keeps unknown lines', () => {
  const existing = '#Minecraft server properties\nonline-mode=true\nenable-rcon=true\nsome-mod-key=1\nmotd=old\n';
  const out = renderProperties(existing, { motd: 'New', difficulty: 'easy' }, null);
  for (const [k, v] of Object.entries(ENFORCED)) assert.match(out, new RegExp(`^${k.replace('.', '\\.')}=${v}$`, 'm'));
  assert.match(out, /^some-mod-key=1$/m);
  assert.match(out, /^motd=New$/m);
  assert.equal((out.match(/^online-mode=/gm) || []).length, 1);
  assert.match(out, /^resource-pack=$/m);
});

test('properties: pack URL must be our https /packs/<sha1>.zip', () => {
  const sha1 = 'a'.repeat(40);
  assert.match(renderProperties('', {}, { url: `https://x.tail1234.ts.net/packs/${sha1}.zip`, sha1 }), /resource-pack-sha1=a{40}/);
  assert.throws(() => renderProperties('', {}, { url: `https://evil.example/x.zip`, sha1 }), /bad pack url/);
  assert.throws(() => renderProperties('', {}, { url: `http://evil.example/packs/${sha1}.zip`, sha1 }), /bad pack url/);
});

// ---------------------------------------------------------------- console allowlist
test('console: allowed commands are rebuilt with their level', () => {
  assert.deepEqual(parseConsole('list'), { command: 'list', level: 'basic' });
  assert.deepEqual(parseConsole('/time set night'), { command: 'time set night', level: 'host' });
  assert.deepEqual(parseConsole('weather clear'), { command: 'weather clear', level: 'host' });
  assert.deepEqual(parseConsole('kick Zbeast spamming'), { command: 'kick Zbeast spamming', level: 'host' });
  assert.deepEqual(parseConsole('whitelist list'), { command: 'whitelist list', level: 'admin' });
  assert.equal(parseConsole('say hello all', { speaker: 'Max' }).command, 'say [Max] hello all');
});

test('console: game rules use the version-appropriate name and validated values', () => {
  assert.equal(parseConsole('gamerule keepInventory true', { mcVersion: '26.3' }).command, 'gamerule keep_inventory true');
  assert.equal(parseConsole('gamerule keepInventory true', { mcVersion: '1.21.4' }).command, 'gamerule keepInventory true');
  assert.throws(() => parseConsole('gamerule keepInventory yes'), /true or false/);
  assert.throws(() => parseConsole('gamerule randomTickSpeed 1000'), /0-10/);
  assert.throws(() => parseConsole('gamerule sendCommandFeedback false'), /not on the dashboard list/);
});

test('console: dangerous or unknown commands are rejected', () => {
  for (const line of ['op Zbeast', 'deop Zbeast', 'whitelist add Bob', 'stop', 'execute run op Bob', 'ban Bob', 'reload', 'give @a diamond 64', 'kick @a', 'time set 1000', 'save-all flush', 'list extra']) {
    assert.throws(() => parseConsole(line), undefined, line);
  }
});

test('console: line breaks and § codes cannot smuggle a second command', () => {
  assert.throws(() => parseConsole('say hi\nop Bob'), /one command/);
  assert.throws(() => parseConsole('say hi\rop Bob'), /one command/);
  assert.throws(() => parseConsole('say \u00a7kspooky'), /not allowed/);
  assert.throws(() => parseConsole('say ' + 'x'.repeat(201)), /longer than/);
});

// ---------------------------------------------------------------- validators
test('offline UUID matches the server (v3 of OfflinePlayer:<name>, case-sensitive)', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  assert.notEqual(offlineUuid('notch'), offlineUuid('Notch'));
  assert.throws(() => offlineUuid('bad name'));
  assert.throws(() => offlineUuid('ab'));
});

test('version compare handles 26.x and 1.21.x', () => {
  assert.equal(compareVersions('26.3', '26.3'), 0);
  assert.equal(compareVersions('26.3.1', '26.3'), 1);
  assert.equal(compareVersions('1.21.11', '26.1'), -1);
  assert.equal(compareVersions('26.10', '26.9'), 1);
});

test('cleanText rejects control characters and § codes', () => {
  assert.throws(() => cleanText('a\u0000b', { field: 'x' }));
  assert.throws(() => cleanText('a\u2028b', { field: 'x' }));
  assert.throws(() => cleanText('\u00a7cRed', { field: 'x' }));
  assert.equal(cleanText('  ok  ', { field: 'x' }), 'ok');
});

// ---------------------------------------------------------------- zip / resource packs
const MCMETA = JSON.stringify({ pack: { pack_format: 60, description: 'test' } });

test('zip: a normal pack passes and gets a sha1', () => {
  const buf = buildZip({ 'pack.mcmeta': MCMETA, 'assets/minecraft/textures/block/stone.png': 'png' });
  const info = inspectPack(buf);
  assert.equal(info.sha1, crypto.createHash('sha1').update(buf).digest('hex'));
  assert.equal(info.entries, 2);
});

test('zip: path traversal and absolute paths are rejected', () => {
  for (const name of ['../evil.txt', 'assets/../../evil', '/etc/passwd', 'C:/win.ini', 'assets\\x.png']) {
    assert.throws(() => inspectPack(buildZip({ 'pack.mcmeta': MCMETA, [name]: 'x' })), /unsafe file/, name);
  }
  assert.equal(badPath('assets/ok..png'), null);
});

test('zip: a missing or nested pack.mcmeta is explained', () => {
  assert.throws(() => inspectPack(buildZip({ 'readme.txt': 'x' })), /pack\.mcmeta is missing/);
  assert.throws(() => inspectPack(buildZip({ 'MyPack/pack.mcmeta': MCMETA })), /inside the folder "MyPack"/);
});

test('zip: not-a-zip, too big, too many files and bomb ratios are rejected', () => {
  assert.throws(() => inspectPack(Buffer.from('hello world, definitely not a zip file')), /not a \.zip/);
  const ok = buildZip({ 'pack.mcmeta': MCMETA });
  assert.throws(() => inspectPack(ok, { maxBytes: 10, maxEntries: 5000, maxTotalUncompressed: 1e9, maxRatio: 100, maxNameLength: 240 }), /larger than/);
  const many = Object.fromEntries([['pack.mcmeta', MCMETA], ...Array.from({ length: 12 }, (_, i) => [`f${i}`, 'x'])]);
  assert.throws(() => inspectPack(buildZip(many), { maxBytes: 1e9, maxEntries: 10, maxTotalUncompressed: 1e9, maxRatio: 100, maxNameLength: 240 }), /more than 10 files/);
  // Forge a central-directory entry claiming a huge uncompressed size (zip bomb shape).
  const bomb = buildZip({ 'pack.mcmeta': MCMETA, 'big.bin': 'x'.repeat(100) });
  const cen = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(100 * 1000, cen + 24);
  assert.throws(() => inspectPack(bomb), /zip bomb/);
});

test('zip: encrypted entries are rejected', () => {
  const buf = buildZip({ 'pack.mcmeta': MCMETA });
  const cen = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt16LE(1, cen + 8);
  assert.throws(() => inspectPack(buf), /encrypted/);
});

// ---------------------------------------------------------------- Modrinth checks
const goodFile = { url: 'https://cdn.modrinth.com/data/AAAAAAAA/versions/1/x.jar', filename: 'x-1.0.jar', primary: true, size: 10, hashes: { sha512: 'a'.repeat(128) } };
const project = { id: 'AAAAAAAA', title: 'X', project_type: 'mod', server_side: 'required' };
const version = { id: 'BBBBBBBB', project_id: 'AAAAAAAA', loaders: ['fabric'], game_versions: ['26.3'], files: [goodFile] };

test('modrinth: a Fabric build for our version is installable', () => {
  assert.equal(assertInstallable(project, version, '26.3'), goodFile);
});

test('modrinth: wrong loader, wrong version, client-only, non-mod, or foreign project are refused', () => {
  assert.throws(() => assertInstallable(project, { ...version, loaders: ['forge'] }, '26.3'), /not for Fabric/);
  assert.throws(() => assertInstallable(project, version, '26.4'), /not for Fabric on Minecraft 26.4/);
  assert.throws(() => assertInstallable({ ...project, server_side: 'unsupported' }, version, '26.3'), /players' own computers/);
  assert.throws(() => assertInstallable({ ...project, project_type: 'shader' }, version, '26.3'), /not a mod/);
  assert.throws(() => assertInstallable(project, { ...version, project_id: 'ZZZZZZZZ' }, '26.3'), /does not belong/);
});

test('modrinth: files must be jars on cdn.modrinth.com with a sha512', () => {
  assert.throws(() => checkFile({ ...goodFile, url: 'https://evil.example/x.jar' }), /cdn\.modrinth\.com/);
  assert.throws(() => checkFile({ ...goodFile, url: 'http://cdn.modrinth.com/x.jar' }), /cdn\.modrinth\.com/);
  assert.throws(() => checkFile({ ...goodFile, hashes: {} }), /sha512/);
  assert.throws(() => checkFile({ ...goodFile, filename: '../../x.jar' }), /file name/);
  assert.throws(() => checkFile({ ...goodFile, size: 1e9 }), /too large/);
});

test('modrinth: a download that does not match the published sha512 is refused', async () => {
  const bytes = Buffer.from('real jar');
  const sha512 = crypto.createHash('sha512').update(bytes).digest('hex');
  const fetchImpl = async () => new Response(Buffer.from('tampered jar'));
  const m = createModrinth({ fetchImpl });
  await assert.rejects(m.download({ ...goodFile, hashes: { sha512 } }), /checksum mismatch/);
  const ok = createModrinth({ fetchImpl: async () => new Response(bytes) });
  assert.deepEqual(await ok.download({ ...goodFile, hashes: { sha512 } }), bytes);
});

test('modrinth: search always sends the Fabric/version/server-side facets', async () => {
  let seen;
  const m = createModrinth({ fetchImpl: async (url) => ((seen = new URL(url)), new Response(JSON.stringify({ total_hits: 0, hits: [] }))) });
  await m.search({ query: 'graves', mcVersion: '26.3' });
  const facets = JSON.parse(seen.searchParams.get('facets'));
  assert.deepEqual(facets, [['project_type:mod'], ['categories:fabric'], ['versions:26.3'], ['server_side:required', 'server_side:optional']]);
});

// ---------------------------------------------------------------- rate limits & log redaction
test('rate limiter: blocks after capacity, refills over time', () => {
  const rl = new RateLimiter({ t: { capacity: 2, refillPerSec: 1 } });
  const t0 = 1_000_000;
  assert.equal(rl.take('a', 't', t0).ok, true);
  assert.equal(rl.take('a', 't', t0).ok, true);
  assert.equal(rl.take('a', 't', t0).ok, false);
  assert.equal(rl.take('b', 't', t0).ok, true, 'buckets are per actor');
  assert.equal(rl.take('a', 't', t0 + 1100).ok, true);
});

test('log redaction hides IPs and auth command arguments', () => {
  assert.equal(redactLogLine('Zbeast[/203.0.113.7:51234] logged in'), 'Zbeast[/‹ip›] logged in');
  assert.match(redactLogLine('Zbeast issued server command: /login hunter2'), /\/login ‹hidden›$/);
  assert.match(redactLogLine('Bob issued server command: /register pw pw'), /\/register ‹hidden›$/);
  assert.doesNotMatch(redactLogLine('[2001:db8::1]:25565 connected'), /2001/);
  assert.equal(redactLogLine('[20:41:13] [Server thread/INFO]: Done (4.2s)!'), '[20:41:13] [Server thread/INFO]: Done (4.2s)!');
  assert.equal(redactLogLine('[2001:0:0:0:0:0:0:1] x'), '‹ip› x');
});
