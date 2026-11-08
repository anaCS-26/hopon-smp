// Console command allowlist. Input is a line typed in the dashboard; output is a command
// rebuilt from validated parts, plus the permission level it needs.
//   level "basic": any member     level "host": host of the active world, admin, owner
import { ValidationError, MC_NAME_RE, compareVersions } from './validate.mjs';

// Game rules friends commonly want. [legacy camelCase, snake_case used since 1.21.11], value type.
// TODO(verify on 26.x): the snake_case names follow the 1.21.11 rename; if the server answers
// "Unknown game rule" for one, fix its name here. The console view shows the server's reply.
const GAMERULES = {
  keepInventory: ['keep_inventory', 'bool'],
  doDaylightCycle: ['advance_time', 'bool'],
  doWeatherCycle: ['advance_weather', 'bool'],
  doMobSpawning: ['spawn_mobs', 'bool'],
  mobGriefing: ['mob_griefing', 'bool'],
  playersSleepingPercentage: ['players_sleeping_percentage', [0, 100]],
  doInsomnia: ['spawn_phantoms', 'bool'],
  doImmediateRespawn: ['immediate_respawn', 'bool'],
  showDeathMessages: ['show_death_messages', 'bool'],
  announceAdvancements: ['show_advancement_messages', 'bool'],
  naturalRegeneration: ['natural_health_regeneration', 'bool'],
  doTraderSpawning: ['spawn_wandering_traders', 'bool'],
  doPatrolSpawning: ['spawn_patrols', 'bool'],
  randomTickSpeed: ['random_tick_speed', [0, 10]],
};
export const SNAKE_CASE_SINCE = '1.21.11';

const TIMES = ['day', 'noon', 'night', 'midnight'];
const WEATHER = ['clear', 'rain', 'thunder'];
const DIFFICULTY = ['peaceful', 'easy', 'normal', 'hard'];

/** Characters allowed in free text (say messages, kick reasons): printable, no § codes, no control chars. */
function freeText(s, max) {
  if (s.length === 0) throw new ValidationError('message is empty');
  if (s.length > max) throw new ValidationError(`message is longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f-\u009f§\u2028\u2029]/.test(s)) throw new ValidationError('message has characters that are not allowed');
  return s;
}

function gameruleName(id, mcVersion) {
  const useSnake = compareVersions(mcVersion, SNAKE_CASE_SINCE) >= 0;
  return useSnake ? GAMERULES[id][0] : id;
}

export const CONSOLE_HELP = [
  { usage: 'list', level: 'basic', about: 'Who is online' },
  { usage: 'say <message>', level: 'basic', about: 'Send a chat message from the dashboard' },
  { usage: 'time set day|noon|night|midnight', level: 'host', about: 'Change the time' },
  { usage: 'weather clear|rain|thunder', level: 'host', about: 'Change the weather' },
  { usage: 'difficulty peaceful|easy|normal|hard', level: 'host', about: 'Change difficulty until restart' },
  { usage: 'gamerule <rule> <value>', level: 'host', about: `Rules: ${Object.keys(GAMERULES).filter((k) => GAMERULES[k][1] !== 'skip').join(', ')}` },
  { usage: 'kick <player> [reason]', level: 'host', about: 'Kick a player' },
  { usage: 'save-all', level: 'host', about: 'Save the world now' },
  { usage: 'whitelist list', level: 'admin', about: 'Show the whitelist' },
];

/**
 * Parse a console line. Returns { command, level }. Throws ValidationError for anything not
 * on the list. `speaker` is the dashboard user's display name, used to label `say`.
 */
export function parseConsole(line, { mcVersion = '26.3', speaker = 'Dashboard' } = {}) {
  if (typeof line !== 'string') throw new ValidationError('command must be text');
  if (/[\r\n\u0000]/.test(line)) throw new ValidationError('one command at a time (no line breaks)');
  const trimmed = line.trim().replace(/^\//, '');
  if (trimmed.length > 256) throw new ValidationError('command is too long');
  const [verb = '', ...rest] = trimmed.split(/\s+/);
  const args = rest;
  const v = verb.toLowerCase();

  switch (v) {
    case 'list':
      if (args.length) break;
      return { command: 'list', level: 'basic' };

    case 'say': {
      const msg = freeText(trimmed.slice(3).trim(), 200);
      const who = String(speaker).replace(/[^A-Za-z0-9_ .-]/g, '').slice(0, 24) || 'Dashboard';
      return { command: `say [${who}] ${msg}`, level: 'basic' };
    }

    case 'time':
      if (args.length === 2 && args[0] === 'set' && TIMES.includes(args[1])) return { command: `time set ${args[1]}`, level: 'host' };
      break;

    case 'weather':
      if (args.length === 1 && WEATHER.includes(args[0])) return { command: `weather ${args[0]}`, level: 'host' };
      break;

    case 'difficulty':
      if (args.length === 1 && DIFFICULTY.includes(args[0])) return { command: `difficulty ${args[0]}`, level: 'host' };
      break;

    case 'gamerule': {
      if (args.length !== 2) break;
      const id = Object.keys(GAMERULES).find((k) => k === args[0] || GAMERULES[k][0] === args[0]);
      if (!id || GAMERULES[id][1] === 'skip') throw new ValidationError(`game rule "${args[0]}" is not on the dashboard list`);
      const kind = GAMERULES[id][1];
      let value;
      if (kind === 'bool') {
        if (!['true', 'false'].includes(args[1])) throw new ValidationError(`${id} must be true or false`);
        value = args[1];
      } else {
        const n = /^\d{1,3}$/.test(args[1]) ? Number(args[1]) : NaN;
        if (!(n >= kind[0] && n <= kind[1])) throw new ValidationError(`${id} must be ${kind[0]}-${kind[1]}`);
        value = String(n);
      }
      return { command: `gamerule ${gameruleName(id, mcVersion)} ${value}`, level: 'host' };
    }

    case 'kick': {
      if (args.length < 1 || !MC_NAME_RE.test(args[0])) throw new ValidationError('kick needs a valid player name');
      const reason = args.length > 1 ? ' ' + freeText(args.slice(1).join(' '), 100) : '';
      return { command: `kick ${args[0]}${reason}`, level: 'host' };
    }

    case 'save-all':
      if (args.length === 0) return { command: 'save-all', level: 'host' };
      break;

    case 'whitelist':
      if (args.length === 1 && args[0] === 'list') return { command: 'whitelist list', level: 'admin' };
      if (args[0] === 'add') throw new ValidationError('use the Crew page to whitelist players (it stores the correct offline UUID)');
      break;

    case 'op':
    case 'deop':
      throw new ValidationError('operator changes are not available from the dashboard');
    case 'stop':
      throw new ValidationError('use the Stop button (it saves and tracks the server state)');
    default:
      throw new ValidationError(`"${verb}" is not on the dashboard command list`);
  }
  throw new ValidationError(`that form of "${v}" is not allowed`);
}

export function gameruleList() {
  return Object.keys(GAMERULES).filter((k) => GAMERULES[k][1] !== 'skip');
}
