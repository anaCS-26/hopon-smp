// Minecraft "Server List Ping" (the same thing the multiplayer screen does) against localhost.
// Gives player count and up to 12 sample names without needing RCON or query.
import net from 'node:net';

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let n = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: n >>> 0, size: i + 1 };
    shift += 7;
  }
  throw new Error('varint too long');
}

function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}

export function ping(host = '127.0.0.1', port = 25565, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null));
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      sock.write(packet(0, Buffer.concat([varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 1024 * 1024) return done(null);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        let o = len.size;
        const id = readVarint(buf, o);
        o += id.size;
        const slen = readVarint(buf, o);
        o += slen.size;
        const json = JSON.parse(buf.subarray(o, o + slen.value).toString('utf8'));
        done({
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          sample: (json.players?.sample || []).map((p) => String(p.name)).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 12),
          version: json.version?.name ?? null,
        });
      } catch {
        done(null);
      }
    });
  });
}
