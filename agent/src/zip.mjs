// Inspect a resource-pack zip WITHOUT extracting it: read the central directory and reject
// anything risky (zip bombs, path traversal, encryption, ZIP64, too many entries).
import crypto from 'node:crypto';

export const PACK_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxEntries: 5000,
  maxTotalUncompressed: 512 * 1024 * 1024,
  maxRatio: 100,
  maxNameLength: 240,
};

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
    this.status = 400;
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function badPath(name) {
  if (name.length === 0) return 'empty file name';
  if (name.includes('\\')) return 'backslash in path';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'drive letter in path';
  if (/[\u0000-\u001f]/.test(name)) return 'control character in path';
  if (name.split('/').some((seg) => seg === '..')) return '".." in path';
  return null;
}

/**
 * Validate a zip buffer. Returns { sha1, size, entries, uncompressed, description }.
 * Throws PackError with a friendly message on anything suspicious.
 */
export function inspectPack(buf, limits = PACK_LIMITS) {
  if (!Buffer.isBuffer(buf)) throw new PackError('no file');
  if (buf.length > limits.maxBytes) throw new PackError(`the pack is larger than ${Math.round(limits.maxBytes / 1048576)} MB`);
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOC_SIG) throw new PackError('that file is not a .zip');

  const eocd = findEocd(buf);
  if (eocd < 0) throw new PackError('the zip is damaged (no end record)');
  const disk = buf.readUInt16LE(eocd + 4);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new PackError('multi-part zips are not supported');
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new PackError('ZIP64 archives are not supported');
  if (total > limits.maxEntries) throw new PackError(`the pack has more than ${limits.maxEntries} files`);
  if (cdOffset + cdSize > eocd) throw new PackError('the zip is damaged (bad directory)');

  let p = cdOffset;
  let uncompressed = 0;
  let hasMcmeta = false;
  const names = new Set();
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN_SIG) throw new PackError('the zip is damaged (bad entry)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;

    if (flags & 0x1) throw new PackError('encrypted zips are not allowed');
    if (method !== 0 && method !== 8) throw new PackError(`unsupported compression in "${name}"`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new PackError('ZIP64 archives are not supported');
    if (nlen > limits.maxNameLength) throw new PackError('a file name in the pack is too long');
    const why = badPath(name);
    if (why) throw new PackError(`unsafe file in pack (${why}): ${name.slice(0, 80)}`);
    if (names.has(name)) throw new PackError(`duplicate file in pack: ${name.slice(0, 80)}`);
    names.add(name);
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOC_SIG) throw new PackError('the zip is damaged (bad local header)');
    if (csize > 0 && usize / csize > limits.maxRatio) throw new PackError('the pack looks like a zip bomb (compression ratio too high)');
    if (csize === 0 && usize > 0) throw new PackError('the zip is damaged (sizes)');
    uncompressed += usize;
    if (uncompressed > limits.maxTotalUncompressed) throw new PackError('the pack unpacks to more than 512 MB');
    if (name === 'pack.mcmeta') hasMcmeta = true;
  }
  if (!hasMcmeta) {
    const nested = [...names].find((n) => /^[^/]+\/pack\.mcmeta$/.test(n));
    throw new PackError(
      nested
        ? `pack.mcmeta is inside the folder "${nested.split('/')[0]}". Zip the files inside that folder, not the folder itself.`
        : 'this is not a resource pack: pack.mcmeta is missing',
    );
  }
  return {
    sha1: crypto.createHash('sha1').update(buf).digest('hex'),
    size: buf.length,
    entries: total,
    uncompressed,
  };
}

/** Build a tiny stored (uncompressed) zip. Used by tests and the mock agent. */
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC_SIG, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    locals.push(loc, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
