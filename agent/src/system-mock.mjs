// A pretend VM for local development and tests: same interface as system-real.mjs, no Linux,
// no Minecraft. Start/stop take a few seconds, fake players wander in and out, logs scroll.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FAKE_PLAYERS = ['Zbeast', 'Goatmoose', 'Taby', 'MossyMax', 'LavaLuna'];

export function createMockSystem({ dataDir, speed = 1 } = {}) {
  const packs = path.join(dataDir, 'packs');
  fs.mkdirSync(packs, { recursive: true });
  const ms = (n) => Math.max(5, Math.round(n / speed));

  let state = 'inactive';
  let players = [];
  let startedAt = 0;
  let marker = null;
  const log = [];
  const backups = [];
  const mods = new Map(); // worldId -> Set(filename)
  const worldHasData = new Set();
  let props = '';

  const stamp = () => new Date().toISOString().slice(11, 19);
  const say = (msg, lvl = 'INFO') => {
    log.push(`[${stamp()}] [Server thread/${lvl}]: ${msg}`);
    if (log.length > 500) log.splice(0, log.length - 500);
  };

  // Players drift in and out while "online".
  const timer = setInterval(() => {
    if (state !== 'active' || Date.now() - startedAt < ms(4000)) return;
    const r = Math.random();
    if (r < 0.15 && players.length < 4) {
      const p = FAKE_PLAYERS.find((n) => !players.includes(n));
      if (p) {
        players.push(p);
        say(`${p} joined the game`);
      }
    } else if (r < 0.22 && players.length) {
      const p = players.splice(Math.floor(Math.random() * players.length), 1)[0];
      say(`${p} left the game`);
    } else if (r < 0.3 && players.length) {
      say(`<${players[0]}> anyone got iron?`);
    }
  }, ms(3000));
  timer.unref?.();

  async function boot() {
    state = 'activating';
    say('Starting minecraft server version 26.3');
    say('Loading 4 mods: fabric-api, easyauth, lithium, ferritecore');
    await sleep(ms(2500));
    say('Preparing level "world"');
    await sleep(ms(1500));
    if (!worldHasData.has(marker)) worldHasData.add(marker);
    state = 'active';
    startedAt = Date.now();
    say('Done (4.213s)! For help, type "help"');
  }
  async function halt() {
    state = 'deactivating';
    say('Stopping the server');
    for (const p of players) say(`${p} lost connection: Server closed`);
    players = [];
    await sleep(ms(1500));
    say('Saving worlds');
    await sleep(ms(500));
    state = 'inactive';
  }

  return {
    mode: 'mock',
    _debug: { get props() { return props; }, mods, backups },

    async serviceState() {
      return state;
    },
    async ping() {
      if (state !== 'active' || Date.now() - startedAt < ms(300)) return null;
      return { online: players.length, max: 10, sample: [...players], version: '26.3' };
    },
    async start() {
      if (state === 'active' || state === 'activating') return;
      await boot();
    },
    async stop() {
      if (state === 'inactive') return;
      await halt();
    },
    async restart() {
      await halt();
      await boot();
    },
    async sendCommand(command) {
      if (/[\r\n]/.test(command)) throw new Error('refusing multi-line command');
      if (state !== 'active') throw Object.assign(new Error('the server is not running'), { status: 409 });
      say(`[Dashboard] ran: ${command}`);
      if (command === 'list') say(`There are ${players.length} of a max of 10 players online: ${players.join(', ')}`);
      else if (command.startsWith('say ')) say(`[Server] ${command.slice(4)}`);
      else if (command.startsWith('kick ')) {
        const name = command.split(' ')[1];
        players = players.filter((p) => p !== name);
        say(`Kicked ${name}`);
      } else if (command.startsWith('time set')) say(`Set the time to ${command.split(' ')[2]}`);
      else if (command.startsWith('weather')) say(`Changing to ${command.split(' ')[1]} weather`);
      else if (command.startsWith('gamerule')) say(`Gamerule ${command.split(' ')[1]} is now set to: ${command.split(' ')[2]}`);
      else if (command === 'save-all') say('Saved the game');
      else if (command === 'whitelist list') say(`There are 3 whitelisted player(s): Zbeast, Goatmoose, Taby`);
    },
    async readLog(lines = 200) {
      // Include a line with an IP and a /login so the dashboard's redaction is visible in dev.
      return log.slice(-lines);
    },
    async resources() {
      const running = state === 'active';
      return {
        cpus: 1,
        load1: running ? 0.35 + players.length * 0.12 + Math.random() * 0.1 : 0.02,
        memTotal: 6 * 1024 ** 3,
        memAvailable: running ? (6 - 4.6 - players.length * 0.1) * 1024 ** 3 : 5.4 * 1024 ** 3,
        diskTotal: 47 * 1024 ** 3,
        diskFree: 38.2 * 1024 ** 3,
      };
    },
    async listBackups() {
      return backups.slice();
    },
    async backup(worldId, kind) {
      await sleep(ms(1200));
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
      const file = `world-${ts}-${worldId}_${kind}.tar.gz`;
      backups.push({ file, size: 20_000_000 + Math.floor(Math.random() * 5_000_000), mtime: new Date().toISOString() });
      say(`mc-backup: wrote /srv/minecraft/backups/${file}`);
      return file;
    },
    async restore(worldId, file) {
      if (!backups.find((b) => b.file === file)) throw Object.assign(new Error('no such backup'), { status: 404 });
      await sleep(ms(1500));
      worldHasData.add(worldId);
    },
    async writeProperties(settings, pack) {
      const { renderProperties } = await import('./properties.mjs');
      props = renderProperties(props, settings, pack);
    },
    async createWorld(worldId) {
      mods.set(worldId, new Set());
    },
    async adoptWorld(worldId) {
      marker = worldId;
      worldHasData.add(worldId);
      if (!mods.has(worldId)) mods.set(worldId, new Set());
    },
    async activeMarker() {
      return marker;
    },
    async activate(fromId, toId) {
      if (state !== 'inactive') throw Object.assign(new Error('stop the server first'), { status: 409 });
      await sleep(ms(400));
      marker = toId;
    },
    async trashWorld(worldId) {
      if (marker === worldId && state !== 'inactive') throw Object.assign(new Error('stop the server first'), { status: 409 });
      mods.delete(worldId);
      worldHasData.delete(worldId);
      if (marker === worldId) marker = null;
    },
    async resetWorld(worldId) {
      if (marker === worldId && state !== 'inactive') throw Object.assign(new Error('stop the server first'), { status: 409 });
      worldHasData.delete(worldId);
    },
    async worldExists() {
      return worldHasData.has(marker);
    },
    async installMod(worldId, filename) {
      await sleep(ms(300));
      if (!mods.has(worldId)) mods.set(worldId, new Set());
      mods.get(worldId).add(filename);
    },
    async removeMod(worldId, filename) {
      mods.get(worldId)?.delete(filename);
    },
    async storePack(sha1, bytes) {
      await fsp.writeFile(path.join(packs, `${sha1}.zip`), bytes);
    },
    packFile: (sha1) => path.join(packs, `${sha1}.zip`),
    async whitelist(name) {
      say(`Whitelisted ${name} (offline UUID)`);
    },
    close() {
      clearInterval(timer);
    },
  };
}

const sleep = (n) => new Promise((r) => setTimeout(r, n));
