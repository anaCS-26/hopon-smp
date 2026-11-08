// server.properties: which keys the dashboard may change, how they are validated,
// and which keys are forced on every write no matter what.
import { ValidationError, cleanText } from './validate.mjs';

const bool = { type: 'bool' };
const int = (min, max) => ({ type: 'int', min, max });
const oneOf = (...values) => ({ type: 'enum', values });

/**
 * Editable keys. `createOnly` keys can be set when a world is created or reset, not later
 * (changing them on an existing world does nothing or breaks it).
 * Ranges are kept small on purpose: the VM has 1-2 OCPU.
 */
export const EDITABLE = {
  motd: { type: 'text', max: 59, label: 'Message of the day' },
  difficulty: { ...oneOf('peaceful', 'easy', 'normal', 'hard'), label: 'Difficulty' },
  gamemode: { ...oneOf('survival', 'creative', 'adventure', 'spectator'), label: 'Default game mode' },
  'force-gamemode': { ...bool, label: 'Force game mode on join' },
  hardcore: { ...bool, createOnly: true, label: 'Hardcore (one life)' },
  pvp: { ...bool, label: 'Player vs player' },
  'max-players': { ...int(1, 20), label: 'Max players' },
  'view-distance': { ...int(3, 12), label: 'View distance (chunks)' },
  'simulation-distance': { ...int(3, 10), label: 'Simulation distance (chunks)' },
  'spawn-protection': { ...int(0, 64), label: 'Spawn protection radius' },
  'allow-flight': { ...bool, label: 'Allow flight (needed by some mods)' },
  'allow-nether': { ...bool, label: 'Allow the Nether' },
  'spawn-monsters': { ...bool, label: 'Spawn monsters' },
  'spawn-animals': { ...bool, label: 'Spawn animals' },
  'spawn-npcs': { ...bool, label: 'Spawn villagers' },
  'enable-command-block': { ...bool, label: 'Command blocks' },
  'player-idle-timeout': { ...int(0, 120), label: 'Kick idle players after (minutes, 0 = never)' },
  'hide-online-players': { ...bool, label: 'Hide player list in server browser' },
  'max-world-size': { ...int(1000, 29999984), label: 'World border radius' },
  'require-resource-pack': { ...bool, label: 'Require the resource pack' },
  'level-seed': { type: 'text', max: 64, createOnly: true, label: 'Seed (blank = random)' },
  'level-type': {
    ...oneOf('minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'),
    createOnly: true,
    label: 'World type',
  },
  'generate-structures': { ...bool, createOnly: true, label: 'Generate structures (villages etc.)' },
};

/** Always written, never editable. The security of an offline-mode server depends on these. */
export const ENFORCED = {
  'online-mode': 'false',
  'white-list': 'true',
  'enforce-whitelist': 'true',
  'enable-rcon': 'false',
  'enable-query': 'false',
  'management-server-enabled': 'false',
  'enable-jmx-monitoring': 'false',
  'accepts-transfers': 'false',
  'level-name': 'world',
  'server-port': '25565',
  'server-ip': '',
};

/** Only the resource-pack flow writes these (with a URL and sha1 it computed itself). */
// https on a real host; plain http only for a local mock agent.
export const PACK_URL_RE = /^(https:\/\/[A-Za-z0-9.-]+(:\d+)?|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)\/packs\/[a-f0-9]{40}\.zip$/;

export const PACK_KEYS = ['resource-pack', 'resource-pack-sha1'];

export const DEFAULT_SETTINGS = {
  motd: 'Hop On SMP',
  difficulty: 'normal',
  gamemode: 'survival',
  'force-gamemode': false,
  hardcore: false,
  pvp: true,
  'max-players': 10,
  'view-distance': 10,
  'simulation-distance': 8,
  'spawn-protection': 0,
  'allow-flight': false,
  'allow-nether': true,
  'spawn-monsters': true,
  'spawn-animals': true,
  'spawn-npcs': true,
  'enable-command-block': false,
  'player-idle-timeout': 0,
  'hide-online-players': false,
  'max-world-size': 29999984,
  'require-resource-pack': false,
  'level-seed': '',
  'level-type': 'minecraft:normal',
  'generate-structures': true,
};

function coerce(key, spec, raw) {
  switch (spec.type) {
    case 'bool':
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      throw new ValidationError(`${key} must be true or false`, key);
    case 'int': {
      const n = typeof raw === 'number' ? raw : /^-?\d{1,9}$/.test(String(raw)) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new ValidationError(`${key} must be a whole number from ${spec.min} to ${spec.max}`, key);
      }
      return n;
    }
    case 'enum':
      if (!spec.values.includes(raw)) throw new ValidationError(`${key} must be one of ${spec.values.join(', ')}`, key);
      return raw;
    case 'text':
      return cleanText(raw, { field: key, max: spec.max });
    default:
      throw new ValidationError(`unsupported key ${key}`, key);
  }
}

/**
 * Validate a partial settings object from the dashboard.
 * mode: "create" allows createOnly keys; "update" rejects them.
 */
export function validateSettings(input, { mode = 'update' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('settings must be an object');
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const spec = Object.hasOwn(EDITABLE, key) ? EDITABLE[key] : null;
    if (!spec) throw new ValidationError(`"${key}" is not a setting the dashboard can change`, key);
    if (spec.createOnly && mode !== 'create') throw new ValidationError(`"${key}" can only be set when a world is created or reset`, key);
    out[key] = coerce(key, spec, raw);
  }
  return out;
}

/** Properties files escape a few characters; values from us are already single-line. */
function escapeValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Merge settings into existing server.properties text. Keeps unknown lines (comments, keys
 * the server added), replaces editable keys, then forces ENFORCED keys. `pack` is
 * {url, sha1} or null (clears the pack).
 */
export function renderProperties(existingText, settings, pack) {
  const validated = validateSettings(settings, { mode: 'create' });
  const values = new Map();
  for (const [k, v] of Object.entries(validated)) values.set(k, String(v));
  values.set('resource-pack', pack ? pack.url : '');
  values.set('resource-pack-sha1', pack ? pack.sha1 : '');
  for (const [k, v] of Object.entries(ENFORCED)) values.set(k, v);

  if (pack) {
    if (!PACK_URL_RE.test(pack.url)) throw new ValidationError('bad pack url');
    if (!/^[a-f0-9]{40}$/.test(pack.sha1)) throw new ValidationError('bad pack sha1');
  }

  const lines = String(existingText || '').split(/\r?\n/);
  const out = [];
  const written = new Set();
  for (const line of lines) {
    const m = /^([A-Za-z0-9._-]+)\s*=/.exec(line);
    if (m && values.has(m[1])) {
      if (!written.has(m[1])) out.push(`${m[1]}=${escapeValue(values.get(m[1]))}`);
      written.add(m[1]);
    } else if (line !== '' || out.length) {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of values) if (!written.has(k)) out.push(`${k}=${escapeValue(v)}`);
  return out.join('\n') + '\n';
}

/** For the UI: the editable schema without internals. */
export function settingsSchema() {
  return Object.entries(EDITABLE).map(([key, s]) => ({
    key,
    label: s.label,
    type: s.type,
    min: s.min,
    max: s.max,
    values: s.values,
    createOnly: !!s.createOnly,
  }));
}
