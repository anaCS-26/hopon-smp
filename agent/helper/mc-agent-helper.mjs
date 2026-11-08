#!/usr/bin/env node
// Privileged file operations for mc-agent. Runs as the `minecraft` user through ONE sudoers rule:
//   mcagent ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/mc-agent/helper/mc-agent-helper.mjs *
// It trusts nothing from the caller: every argument is re-validated here, every path is built
// from fixed roots, and it refuses to touch the live world while the server is running.
// sudo resets the environment, so the caller cannot inject NODE_OPTIONS/PATH.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderProperties } from '../src/properties.mjs';

export const ROOTS = {
  home: '/srv/minecraft',
  staging: '/var/lib/mc-agent/staging',
  mcBackup: '/usr/local/bin/mc-backup',
  systemctl: '/usr/bin/systemctl',
  tar: '/usr/bin/tar',
};

const WORLD_ID = /^[a-z0-9]{3,24}$/;
const JAR = /^[A-Za-z0-9._+-]{1,128}\.jar$/;
const SHA512 = /^[a-f0-9]{128}$/;
const KIND = /^[a-z]{3,16}$/;
const BACKUP = /^world-\d{8}-\d{6}Z-[A-Za-z0-9_-]{1,64}\.tar\.gz$/;

class HelperError extends Error {}
const fail = (msg) => {
  throw new HelperError(msg);
};
const need = (re, v, what) => (typeof v === 'string' && re.test(v) ? v : fail(`bad ${what}`));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

export function createHelper(roots = ROOTS, { serviceState } = {}) {
  const server = path.join(roots.home, 'server');
  const worlds = path.join(roots.home, 'worlds');
  const backups = path.join(roots.home, 'backups');
  const trash = path.join(roots.home, 'trash');
  const marker = path.join(server, '.hopon-active');

  const state = serviceState || (() => {
    try {
      return execFileSync(roots.systemctl, ['is-active', 'minecraft.service'], { encoding: 'utf8' }).trim();
    } catch (e) {
      return String(e.stdout || 'unknown').trim();
    }
  });
  const requireStopped = () => {
    const s = state();
    if (!['inactive', 'failed', 'unknown'].includes(s)) fail(`the server is ${s}; stop it first`);
  };
  const active = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null);
  const worldDir = (id) => path.join(worlds, id);
  const modsDir = (id) => (active() === id ? path.join(server, 'mods') : path.join(worldDir(id), 'mods'));
  const mkdir = (d) => fs.mkdirSync(d, { recursive: true, mode: 0o750 });
  const toTrash = (src, label) => {
    if (!fs.existsSync(src)) return null;
    mkdir(trash);
    const dest = path.join(trash, `${label}-${stamp()}-${crypto.randomBytes(3).toString('hex')}`);
    fs.renameSync(src, dest);
    return dest;
  };
  const writeAtomic = (file, data) => {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o640 });
    fs.renameSync(tmp, file);
  };

  const verbs = {
    'write-properties'(_args, stdin) {
      const { settings, pack } = JSON.parse(stdin || '{}');
      const file = path.join(server, 'server.properties');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      writeAtomic(file, renderProperties(existing, settings, pack || null)); // re-validates everything
      return { ok: true };
    },

    'create-world'([id]) {
      need(WORLD_ID, id, 'world id');
      if (fs.existsSync(worldDir(id)) || active() === id) fail('world already exists');
      mkdir(path.join(worldDir(id), 'mods'));
      return { ok: true };
    },

    adopt([id]) {
      need(WORLD_ID, id, 'world id');
      if (active()) fail('a world is already registered as active');
      mkdir(worlds);
      writeAtomic(marker, id + '\n');
      return { ok: true };
    },

    activate([from, to]) {
      need(WORLD_ID, to, 'world id');
      if (from !== '-') need(WORLD_ID, from, 'world id');
      requireStopped();
      const cur = active();
      if ((cur || '-') !== from) fail(`active world is ${cur || 'none'}, not ${from}`);
      if (from === to) fail('that world is already active');
      if (!fs.existsSync(worldDir(to))) fail('target world does not exist');
      for (const sub of ['world', 'mods']) {
        const src = path.join(server, sub);
        if (fs.existsSync(src)) {
          if (from === '-') fail(`server/${sub} exists but no world is registered; adopt it first`);
          mkdir(worldDir(from));
          const dest = path.join(worldDir(from), sub);
          if (fs.existsSync(dest)) fail(`worlds/${from}/${sub} already exists`);
          fs.renameSync(src, dest);
        }
      }
      for (const sub of ['world', 'mods']) {
        const src = path.join(worldDir(to), sub);
        if (fs.existsSync(src)) fs.renameSync(src, path.join(server, sub));
      }
      mkdir(path.join(server, 'mods'));
      writeAtomic(marker, to + '\n');
      return { ok: true };
    },

    'install-mod'([id, filename, sha512]) {
      need(WORLD_ID, id, 'world id');
      need(JAR, filename, 'file name');
      need(SHA512, sha512, 'sha512');
      if (!fs.existsSync(worldDir(id)) && active() !== id) fail('no such world');
      const staged = path.join(roots.staging, `${sha512.slice(0, 32)}.jar`);
      const bytes = fs.readFileSync(staged);
      if (crypto.createHash('sha512').update(bytes).digest('hex') !== sha512) fail('staged file does not match its sha512');
      const dir = modsDir(id);
      mkdir(dir);
      writeAtomic(path.join(dir, filename), bytes);
      return { ok: true };
    },

    'remove-mod'([id, filename]) {
      need(WORLD_ID, id, 'world id');
      need(JAR, filename, 'file name');
      const file = path.join(modsDir(id), filename);
      if (!fs.existsSync(file)) return { ok: true, missing: true };
      toTrash(file, `${id}-mod-${filename}`);
      return { ok: true };
    },

    backup([id, kind]) {
      need(WORLD_ID, id, 'world id');
      need(KIND, kind, 'backup kind');
      const tag = `${id}_${kind}`;
      if (active() === id) {
        const out = execFileSync(roots.mcBackup, [tag], { encoding: 'utf8', timeout: 900_000 });
        const m = /wrote \S*\/(world-[^\s/]+\.tar\.gz)/.exec(out);
        if (!m) fail(`mc-backup did not report a file: ${out.slice(-200)}`);
        return { file: m[1] };
      }
      const src = path.join(worldDir(id), 'world');
      if (!fs.existsSync(src)) return { file: null, skipped: 'world never played' };
      mkdir(backups);
      const file = `world-${stamp()}-${tag}.tar.gz`;
      const out = path.join(backups, file);
      execFileSync(roots.tar, ['-czf', `${out}.partial`, '-C', worldDir(id), 'world'], { timeout: 900_000 });
      fs.renameSync(`${out}.partial`, out);
      return { file };
    },

    restore([id, file]) {
      need(WORLD_ID, id, 'world id');
      need(BACKUP, file, 'backup file');
      const archive = path.join(backups, file);
      if (!fs.existsSync(archive)) fail('backup not found');
      const isActive = active() === id;
      if (isActive) requireStopped();
      const base = isActive ? server : worldDir(id);
      if (!fs.existsSync(base)) fail('no such world');
      const tmp = path.join(roots.home, `.restore-${id}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      mkdir(tmp);
      try {
        // GNU tar refuses absolute and ".." member names by default; we extract only "world/".
        execFileSync(roots.tar, ['-xzf', archive, '-C', tmp, '--no-same-owner', '--no-same-permissions', 'world'], { timeout: 900_000 });
        if (!fs.existsSync(path.join(tmp, 'world', 'level.dat'))) fail('that backup has no world/level.dat');
        toTrash(path.join(base, 'world'), `${id}-prerestore`);
        fs.renameSync(path.join(tmp, 'world'), path.join(base, 'world'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return { ok: true };
    },

    'trash-world'([id]) {
      need(WORLD_ID, id, 'world id');
      if (active() === id) {
        requireStopped();
        const dest = path.join(trash, `${id}-${stamp()}`);
        mkdir(dest);
        for (const sub of ['world', 'mods']) if (fs.existsSync(path.join(server, sub))) fs.renameSync(path.join(server, sub), path.join(dest, sub));
        fs.rmSync(marker, { force: true });
        return { trashed: dest };
      }
      return { trashed: toTrash(worldDir(id), id) };
    },

    'reset-world'([id]) {
      need(WORLD_ID, id, 'world id');
      const isActive = active() === id;
      if (isActive) requireStopped();
      const w = path.join(isActive ? server : worldDir(id), 'world');
      return { trashed: toTrash(w, `${id}-reset`) };
    },
  };

  return function run(verb, args = [], stdin = '') {
    if (!Object.hasOwn(verbs, verb)) fail(`unknown verb ${verb}`);
    if (args.length > 3) fail('too many arguments');
    return verbs[verb](args, stdin);
  };
}

// CLI entry (only when executed directly, not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [verb, ...args] = process.argv.slice(2);
  const chunks = [];
  const readStdin = verb === 'write-properties';
  const finish = () => {
    try {
      const out = createHelper()(verb, args, Buffer.concat(chunks).toString('utf8'));
      process.stdout.write(JSON.stringify(out) + '\n');
    } catch (e) {
      process.stderr.write(`mc-agent-helper: ${e instanceof HelperError ? e.message : 'internal error'}\n`);
      if (!(e instanceof HelperError)) process.stderr.write(String(e?.stack || e) + '\n');
      process.exit(1);
    }
  };
  if (readStdin) {
    process.stdin.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, x) => n + x.length, 0) > 64 * 1024) process.exit(2);
    });
    process.stdin.on('end', finish);
  } else finish();
}
