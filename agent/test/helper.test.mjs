// The privileged helper against a throwaway /srv/minecraft tree.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createHelper } from '../helper/mc-agent-helper.mjs';

let root, roots, svcState, run;
const sha = (b) => crypto.createHash('sha512').update(b).digest('hex');
const p = (...x) => path.join(root, 'srv', ...x);
// On Windows, GNU tar from Git reads "C:" as a remote host; use the built-in bsdtar instead.
const TAR = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
const hasTar = (() => {
  try {
    execFileSync(TAR, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hopon-helper-'));
  roots = { home: path.join(root, 'srv'), staging: path.join(root, 'staging'), mcBackup: '/bin/false', systemctl: '/bin/false', tar: TAR };
  fs.mkdirSync(p('server', 'world'), { recursive: true });
  fs.writeFileSync(p('server', 'world', 'level.dat'), 'old world');
  fs.mkdirSync(p('server', 'mods'), { recursive: true });
  fs.writeFileSync(p('server', 'mods', 'easyauth--3.4.4.jar'), 'ea');
  fs.mkdirSync(roots.staging, { recursive: true });
  svcState = 'inactive';
  run = createHelper(roots, { serviceState: () => svcState });
});

test('helper: unknown verbs and bad arguments are refused', () => {
  assert.throws(() => run('rm', ['-rf', '/']), /unknown verb/);
  assert.throws(() => run('create-world', ['../etc']), /bad world id/);
  assert.throws(() => run('install-mod', ['hopon', '../../x.jar', 'a'.repeat(128)]), /bad file name/);
  assert.throws(() => run('backup', ['hopon', 'x; rm -rf /']), /bad backup kind/);
  assert.throws(() => run('restore', ['hopon', '../../../etc/shadow']), /bad backup file/);
  assert.throws(() => run('activate', ['hopon', 'b', 'c', 'd']), /too many/);
});

test('helper: adopt, create and switch worlds by renaming, only while stopped', () => {
  run('adopt', ['hopon']);
  run('create-world', ['wnew0001']);
  svcState = 'active';
  assert.throws(() => run('activate', ['hopon', 'wnew0001']), /stop it first/);
  svcState = 'inactive';
  assert.throws(() => run('activate', ['wnew0001', 'hopon']), /active world is hopon/);
  run('activate', ['hopon', 'wnew0001']);
  assert.equal(fs.readFileSync(p('worlds', 'hopon', 'world', 'level.dat'), 'utf8'), 'old world');
  assert.ok(fs.existsSync(p('worlds', 'hopon', 'mods', 'easyauth--3.4.4.jar')));
  assert.ok(!fs.existsSync(p('server', 'world')), 'new world starts empty');
  assert.equal(fs.readFileSync(p('server', '.hopon-active'), 'utf8').trim(), 'wnew0001');
  run('activate', ['wnew0001', 'hopon']);
  assert.equal(fs.readFileSync(p('server', 'world', 'level.dat'), 'utf8'), 'old world');
});

test('helper: install-mod re-checks the sha512 and writes to the right folder', () => {
  run('adopt', ['hopon']);
  run('create-world', ['wnew0001']);
  const jar = Buffer.from('lithium bytes');
  const h = sha(jar);
  fs.writeFileSync(path.join(roots.staging, `${h.slice(0, 32)}.jar`), jar);
  run('install-mod', ['wnew0001', 'lithium--1.0.jar', h]);
  assert.ok(fs.existsSync(p('worlds', 'wnew0001', 'mods', 'lithium--1.0.jar')));
  run('install-mod', ['hopon', 'lithium--1.0.jar', h]);
  assert.ok(fs.existsSync(p('server', 'mods', 'lithium--1.0.jar')), 'active world -> server/mods');
  const wrong = 'c'.repeat(128);
  fs.writeFileSync(path.join(roots.staging, `${wrong.slice(0, 32)}.jar`), jar);
  assert.throws(() => run('install-mod', ['hopon', 'evil.jar', wrong]), /does not match/);
  run('remove-mod', ['hopon', 'lithium--1.0.jar']);
  assert.ok(!fs.existsSync(p('server', 'mods', 'lithium--1.0.jar')));
  assert.ok(fs.readdirSync(p('trash')).some((n) => n.startsWith('hopon-mod-lithium')), 'removed mods go to trash');
});

test('helper: write-properties enforces security keys whatever the input says', () => {
  fs.writeFileSync(p('server', 'server.properties'), 'online-mode=true\nenable-rcon=true\nmotd=x\n');
  run('write-properties', [], JSON.stringify({ settings: { motd: 'Hi', difficulty: 'hard' } }));
  const out = fs.readFileSync(p('server', 'server.properties'), 'utf8');
  assert.match(out, /^online-mode=false$/m);
  assert.match(out, /^enable-rcon=false$/m);
  assert.match(out, /^white-list=true$/m);
  assert.throws(() => run('write-properties', [], JSON.stringify({ settings: { 'online-mode': true } })), /not a setting/);
});

test('helper: deleting and resetting move to trash, never delete; live world is protected', () => {
  run('adopt', ['hopon']);
  run('create-world', ['wold0001']);
  fs.mkdirSync(p('worlds', 'wold0001', 'world'), { recursive: true });
  run('trash-world', ['wold0001']);
  assert.ok(!fs.existsSync(p('worlds', 'wold0001')));
  assert.ok(fs.readdirSync(p('trash')).some((n) => n.startsWith('wold0001-')));
  svcState = 'active';
  assert.throws(() => run('reset-world', ['hopon']), /stop it first/);
  assert.throws(() => run('trash-world', ['hopon']), /stop it first/);
  svcState = 'inactive';
  run('reset-world', ['hopon']);
  assert.ok(!fs.existsSync(p('server', 'world')));
  assert.ok(fs.existsSync(p('server', 'mods')), 'reset keeps mods');
});

test('helper: inactive-world backup and restore round-trip', { skip: !hasTar && 'tar not available' }, () => {
  run('adopt', ['hopon']);
  run('create-world', ['wbak0001']);
  fs.mkdirSync(p('worlds', 'wbak0001', 'world'), { recursive: true });
  fs.writeFileSync(p('worlds', 'wbak0001', 'world', 'level.dat'), 'v1');
  const { file } = run('backup', ['wbak0001', 'manual']);
  assert.match(file, /^world-\d{8}-\d{6}Z-wbak0001_manual\.tar\.gz$/);
  fs.writeFileSync(p('worlds', 'wbak0001', 'world', 'level.dat'), 'v2 (griefed)');
  run('restore', ['wbak0001', file]);
  assert.equal(fs.readFileSync(p('worlds', 'wbak0001', 'world', 'level.dat'), 'utf8'), 'v1');
  assert.ok(fs.readdirSync(p('trash')).some((n) => n.startsWith('wbak0001-prerestore')), 'the replaced world is kept in trash');
});
