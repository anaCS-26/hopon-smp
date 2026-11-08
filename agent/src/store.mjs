// Tiny JSON state store (users, invites, worlds, queue) with atomic writes, plus an
// append-only audit log. Data is small (a few dozen records), so a file is plenty.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EMPTY_STATE = () => ({
  version: 1,
  users: [],
  invites: [],
  worlds: [],
  queue: [],
  server: { activeWorldId: null, software: 'fabric', mcVersion: '26.3', pendingRestart: false, session: null, activations: [] },
});

export class Store {
  /** dir = null keeps everything in memory (tests). */
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'state.json') : null;
    this.auditFile = dir ? path.join(dir, 'audit.jsonl') : null;
    this.memAudit = [];
    this.state = EMPTY_STATE();
    if (this.file && fs.existsSync(this.file)) {
      this.state = { ...EMPTY_STATE(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Run a mutation and persist it. */
  mutate(fn) {
    const r = fn(this.state);
    this.save();
    return r;
  }

  get s() {
    return this.state;
  }

  user(id) {
    return this.state.users.find((u) => u.id === id) || null;
  }
  userByDiscord(discordId) {
    return this.state.users.find((u) => u.discordId === discordId) || null;
  }
  world(id) {
    return this.state.worlds.find((w) => w.id === id && w.status !== 'deleted') || null;
  }
  liveWorlds() {
    return this.state.worlds.filter((w) => w.status !== 'deleted');
  }
  activeWorld() {
    return this.state.server.activeWorldId ? this.world(this.state.server.activeWorldId) : null;
  }

  audit(entry) {
    const line = { ts: new Date().toISOString(), ...entry };
    if (this.auditFile) fs.appendFileSync(this.auditFile, JSON.stringify(line) + '\n', { mode: 0o600 });
    else this.memAudit.push(line);
    return line;
  }

  /** Most recent audit entries, newest first. Reads only the tail of the file. */
  readAudit(limit = 100) {
    if (!this.auditFile) return this.memAudit.slice(-limit).reverse();
    if (!fs.existsSync(this.auditFile)) return [];
    const st = fs.statSync(this.auditFile);
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(this.auditFile, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (len < st.size) lines.shift(); // first line may be partial
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

/** Short random ids: lowercase base32-ish, safe in paths and backup tags. */
export function newId(prefix = '', len = 8) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let s = prefix;
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
