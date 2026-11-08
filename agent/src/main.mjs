// Entry point.
//   Real (on the VM, via systemd):  node src/main.mjs
//   Mock (laptop, no VM needed):    node src/main.mjs --mock      (reads agent/.env.mock if present)
//
// Configuration (env, or for secrets a systemd credential file):
//   AGENT_HMAC_KEYS      kid:base64key[,kid2:base64key2]   (or credential "hmac-keys")
//   AGENT_LISTEN         127.0.0.1:8787
//   AGENT_PUBLIC_URL     https://<machine>.<tailnet>.ts.net   (used for pack URLs and uploads)
//   DASHBOARD_ORIGIN     https://<your-dashboard>.vercel.app  (CORS for pack uploads)
//   OWNER_DISCORD_ID     your Discord user id (becomes the Team Leader on first login)
//   JOIN_ADDRESS         hopon-smp.duckdns.org
//   AGENT_DATA_DIR       /var/lib/mc-agent
//   MC_VERSION           optional override; otherwise read from the server's .install-state
//   DISCORD_WEBHOOK_URL  optional: post "server online" / "world switched" to a channel
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseKeys } from './hmac.mjs';
import { Store } from './store.mjs';
import { createService } from './service.mjs';
import { createHttpServer } from './http.mjs';
import { createModrinth } from './modrinth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = process.argv.includes('--mock');
const offline = process.argv.includes('--offline');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

function credential(name) {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  const f = path.join(dir, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}

if (mock) loadEnvFile(path.join(here, '..', '.env.mock'));

const env = process.env;
const [host, port] = (env.AGENT_LISTEN || '127.0.0.1:8787').split(':');
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  console.error('Refusing to listen on a non-loopback address. Tailscale Funnel connects to localhost.');
  process.exit(1);
}

const keys = parseKeys(credential('hmac-keys') || env.AGENT_HMAC_KEYS);
const dataDir = env.AGENT_DATA_DIR || (mock ? path.join(os.tmpdir(), 'hopon-mock-agent') : '/var/lib/mc-agent');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o711 });

const webhook = credential('discord-webhook') || env.DISCORD_WEBHOOK_URL || '';
const notify = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(webhook)
  ? async (content) => {
      await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(5000) });
    }
  : async () => {};

const system = mock
  ? (await import('./system-mock.mjs')).createMockSystem({ dataDir, speed: Number(env.MOCK_SPEED || 1) })
  : (await import('./system-real.mjs')).createRealSystem({ dataDir });

let mcVersion = env.MC_VERSION || null;
if (!mcVersion && !mock) {
  const st = fs.existsSync('/srv/minecraft/server/.install-state') ? fs.readFileSync('/srv/minecraft/server/.install-state', 'utf8') : '';
  mcVersion = (/^mc_version=(.+)$/m.exec(st) || [])[1] || null;
}

if (!mock) {
  for (const k of ['AGENT_PUBLIC_URL', 'DASHBOARD_ORIGIN', 'OWNER_DISCORD_ID']) {
    if (!env[k] || env[k].includes('REPLACE')) {
      console.error(`Set ${k} in /etc/mc-agent/agent.env (see agent/install/agent.env.example).`);
      process.exit(1);
    }
  }
  if (!/^https:\/\//.test(env.AGENT_PUBLIC_URL)) {
    console.error('AGENT_PUBLIC_URL must be https:// (the Tailscale Funnel URL).');
    process.exit(1);
  }
}

const config = {
  mode: mock ? 'mock' : 'real',
  publicUrl: env.AGENT_PUBLIC_URL || `http://127.0.0.1:${port}`,
  dashboardOrigin: env.DASHBOARD_ORIGIN || (mock ? 'http://localhost:3000' : ''),
  ownerDiscordId: env.OWNER_DISCORD_ID || (mock ? '100000000000000001' : ''),
  joinAddress: env.JOIN_ADDRESS || 'hopon-smp.duckdns.org',
  mcVersion: mcVersion || '26.3',
  mockSpeedup: mock,
  packFile: (sha1) => system.packFile(sha1),
};

const store = new Store(mock && env.MOCK_PERSIST !== '1' ? null : dataDir);
const modrinth = offline ? (await import('../test/fixtures/fake-modrinth.mjs')).createFakeModrinth() : createModrinth();
const svc = createService({ store, system, modrinth, config, notify });
await svc.init();
if (mock && store.s.users.length === 0) (await import('./mock-seed.mjs')).seed(store, system);

const server = createHttpServer({ svc, keys, config });
server.listen(Number(port), host, () => {
  console.log(`mc-agent ${config.mode} mode listening on http://${host}:${port}` + (offline ? ' (offline Modrinth fixtures)' : ''));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    system.close?.();
    process.exit(0);
  });
}
