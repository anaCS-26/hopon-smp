// Small, strict validators shared by the agent and the privileged helper.
import crypto from 'node:crypto';

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.field = field;
  }
}

// Minecraft Java names: 3-16 of letters, digits and underscore. Case-sensitive in offline mode.
export const MC_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// World ids: short lowercase tokens. No "_" so backup tags can split on it.
export const WORLD_ID_RE = /^[a-z0-9]{3,24}$/;
export const USER_ID_RE = /^[a-z0-9]{6,32}$/;
export const MODRINTH_ID_RE = /^[A-Za-z0-9]{8}$/;
export const SHA1_RE = /^[a-f0-9]{40}$/;
export const SHA512_RE = /^[a-f0-9]{128}$/;
// Anything a human types that ends up in a file or a console line.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function isMcName(s) {
  return typeof s === 'string' && MC_NAME_RE.test(s);
}

export function assertWorldId(id) {
  if (typeof id !== 'string' || !WORLD_ID_RE.test(id)) throw new ValidationError('bad world id', 'worldId');
  return id;
}

/** Plain single-line text: no control characters, trimmed, length-limited. */
export function cleanText(value, { field, min = 0, max = 64, allowSection = false } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  const v = value.trim();
  if (v.length < min) throw new ValidationError(`${field} must be at least ${min} characters`, field);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  if (CONTROL_RE.test(v)) throw new ValidationError(`${field} contains control characters`, field);
  if (!allowSection && v.includes('§')) throw new ValidationError(`${field} cannot contain § codes`, field);
  return v;
}

/** Offline-mode UUID: v3 (MD5) of "OfflinePlayer:<name>", exactly like the server computes it. */
export function offlineUuid(name) {
  if (!isMcName(name)) throw new ValidationError('bad Minecraft name', 'mcName');
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Compare dotted versions like 26.3, 26.3.1, 1.21.11. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export const MC_VERSION_RE = /^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/;
