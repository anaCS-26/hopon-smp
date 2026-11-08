// The real VM adapter. Every privileged step goes through exact sudo rules:
//   sudo -n /usr/bin/systemctl start|stop|restart minecraft.service          (root)
//   sudo -n /usr/local/bin/mc-allow <name>                                   (root)
//   sudo -n -u minecraft /usr/bin/node <helper> <verb> <args...>             (minecraft)
// See agent/install/sudoers.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ping } from './slp.mjs';
import { assertWorldId, isMcName } from './validate.mjs';

const run = promisify(execFile);

export const PATHS = {
  mcHome: '/srv/minecraft',
  server: '/srv/minecraft/server',
  backups: '/srv/minecraft/backups',
  helper: '/opt/mc-agent/helper/mc-agent-helper.mjs',
  node: '/usr/bin/node',
  systemctl: '/usr/bin/systemctl',
  mcAllow: '/usr/local/bin/mc-allow',
  mcCmd: '/usr/local/bin/mc-cmd',
};

export function createRealSystem({ dataDir, paths = PATHS }) {
  const staging = path.join(dataDir, 'staging');
  const packs = path.join(dataDir, 'packs');
  fs.mkdirSync(staging, { recursive: true, mode: 0o750 });
  fs.mkdirSync(packs, { recursive: true, mode: 0o750 });

  async function sudo(args, { input, timeout = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sudo', ['-n', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      let out = '';
      let err = '';
      const t = setTimeout(() => child.kill('SIGTERM'), timeout);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(Object.assign(new Error((err || out || `exit ${code}`).trim().slice(0, 400)), { status: 500 }));
      });
      child.stdin.end(input ?? '');
    });
  }
  const helper = (verb, args = [], opts) => sudo(['-u', 'minecraft', paths.node, paths.helper, verb, ...args], opts);

  return {
    mode: 'real',

    async serviceState() {
      try {
        const { stdout } = await run(paths.systemctl, ['is-active', 'minecraft.service']);
        return stdout.trim();
      } catch (e) {
        return (e.stdout || '').trim() || 'unknown';
      }
    },
    ping: () => ping('127.0.0.1', 25565, 2500),
    start: () => sudo([paths.systemctl, 'start', 'minecraft.service'], { timeout: 60_000 }),
    stop: () => sudo([paths.systemctl, 'stop', 'minecraft.service'], { timeout: 240_000 }),
    restart: () => sudo([paths.systemctl, 'restart', 'minecraft.service'], { timeout: 300_000 }),

    async sendCommand(command) {
      // `command` was rebuilt by console.mjs; still refuse line breaks as a last line of defence.
      if (/[\r\n]/.test(command)) throw new Error('refusing multi-line command');
      await run(paths.mcCmd, [command], { timeout: 10_000 });
    },

    async readLog(lines = 200) {
      const file = path.join(paths.server, 'logs', 'latest.log');
      try {
        const st = await fsp.stat(file);
        const len = Math.min(st.size, 256 * 1024);
        const fh = await fsp.open(file, 'r');
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        await fh.close();
        return buf.toString('utf8').split('\n').slice(-lines - 1, -1);
      } catch {
        return [];
      }
    },

    async resources() {
      const meminfo = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => '');
      const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo) || [])[1] || 0) * 1024;
      const st = await fsp.statfs(paths.mcHome).catch(() => null);
      return {
        cpus: os.cpus().length,
        load1: os.loadavg()[0],
        memTotal: kb('MemTotal') || os.totalmem(),
        memAvailable: kb('MemAvailable') || os.freemem(),
        diskTotal: st ? st.blocks * st.bsize : 0,
        diskFree: st ? st.bavail * st.bsize : 0,
      };
    },

    async listBackups() {
      const names = await fsp.readdir(paths.backups).catch(() => []);
      const out = [];
      for (const name of names) {
        if (!/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(name)) continue;
        const st = await fsp.stat(path.join(paths.backups, name)).catch(() => null);
        if (st?.isFile()) out.push({ file: name, size: st.size, mtime: st.mtime.toISOString() });
      }
      return out;
    },

    backup: async (worldId, kind) => JSON.parse(await helper('backup', [assertWorldId(worldId), kind], { timeout: 900_000 })).file,

    /** Mods already in server/mods (installed by setup-minecraft.sh as "<slug>--<version>.jar"). */
    async scanActiveMods() {
      const names = await fsp.readdir(path.join(paths.server, 'mods')).catch(() => []);
      return names
        .filter((n) => /^[A-Za-z0-9._+-]{1,128}\.jar$/.test(n))
        .map((n) => {
          const m = /^([a-z0-9-]+)--(.+)\.jar$/.exec(n);
          const slug = m ? m[1] : n.replace(/\.jar$/, '');
          return { projectId: null, slug, title: slug, versionNumber: m ? m[2] : '?', gameVersions: null, filename: n, clientSide: null, serverSide: null, requires: [], protected: ['fabric-api', 'easyauth'].includes(slug) };
        });
    },
    restore: (worldId, file) => helper('restore', [assertWorldId(worldId), file], { timeout: 900_000 }),
    writeProperties: (settings, pack) => helper('write-properties', [], { input: JSON.stringify({ settings, pack }) }),
    createWorld: (worldId) => helper('create-world', [assertWorldId(worldId)]),
    adoptWorld: (worldId) => helper('adopt', [assertWorldId(worldId)]),
    activeMarker: async () => (await fsp.readFile(path.join(paths.server, '.hopon-active'), 'utf8').catch(() => '')).trim() || null,
    activate: (fromId, toId) => helper('activate', [fromId ? assertWorldId(fromId) : '-', assertWorldId(toId)], { timeout: 120_000 }),
    trashWorld: (worldId) => helper('trash-world', [assertWorldId(worldId)], { timeout: 120_000 }),
    resetWorld: (worldId) => helper('reset-world', [assertWorldId(worldId)], { timeout: 120_000 }),
    worldExists: async () => fs.existsSync(path.join(paths.server, 'world', 'level.dat')),

    async installMod(worldId, filename, bytes, sha512) {
      const staged = path.join(staging, `${sha512.slice(0, 32)}.jar`);
      await fsp.writeFile(staged, bytes, { mode: 0o640 });
      try {
        await helper('install-mod', [assertWorldId(worldId), filename, sha512]);
      } finally {
        await fsp.rm(staged, { force: true });
      }
    },
    removeMod: (worldId, filename) => helper('remove-mod', [assertWorldId(worldId), filename]),

    async storePack(sha1, bytes) {
      await fsp.writeFile(path.join(packs, `${sha1}.zip`), bytes, { mode: 0o640 });
    },
    packFile: (sha1) => path.join(packs, `${sha1}.zip`),

    async whitelist(name) {
      if (!isMcName(name)) throw new Error('bad name');
      return sudo([paths.mcAllow, name]);
    },
  };
}
