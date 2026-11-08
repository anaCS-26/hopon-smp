// Original pixel art drawn as SVG rects: the Hop On frog, procedural player faces,
// world "blocks" and the hills backdrop. No game textures are used anywhere.

type Grid = string[];

function PixelGrid({ grid, palette, size, title, className }: { grid: Grid; palette: Record<string, string>; size: number; title?: string; className?: string }) {
  const h = grid.length;
  const w = Math.max(...grid.map((r) => r.length));
  const rects: React.ReactNode[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === c) run++;
      if (c !== '.' && palette[c]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={run} height={1} fill={palette[c]} />);
      x += run;
    }
  });
  return (
    <svg className={className ?? 'pixel-icon'} width={(size * w) / Math.max(w, h)} height={(size * h) / Math.max(w, h)} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      {rects}
    </svg>
  );
}

const FROG: Grid = [
  '..kkk..kkk..',
  '.kwwwkkwwwk.',
  '.kwpwggwpwk.',
  'kgwwwggwwwgk',
  'kggggggggggk',
  'kgrgkggkgrgk',
  'kggggkkggggk',
  '.kgllllllgk.',
  'kdgllllllgdk',
  'kddgkddkgddk',
  '.kkk.kk.kkk.',
];
const FROG_PAL = { k: '#122010', w: '#ffffff', p: '#101010', g: '#6fd157', d: '#3c8a2e', l: '#c9f3a3', r: '#ff8f8f' };

export function Frog({ size = 44, className = 'frog' }: { size?: number; className?: string }) {
  return <PixelGrid grid={FROG} palette={FROG_PAL} size={size} className={className} title="Hop On frog" />;
}

// ---------------------------------------------------------------- procedural faces
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SKINS = ['#f2c9a0', '#e0ac7e', '#c68b5c', '#9c6440', '#6e4428', '#f5d6c0'];
const HAIRS = ['#2b1d14', '#5a3a1e', '#a0662b', '#e7c35a', '#d9542f', '#3a3a52', '#7a49c9', '#2f8f6a', '#e6e2da'];
const EYES = ['#1a3b8f', '#2c6e2c', '#4a2c18', '#5fe3e8', '#7a2d9c'];
const HATS = ['#ff5c50', '#5fe3e8', '#ffb84d', '#6fd157', '#b88dff'];

/** 8x8 face from a name: same name, same face. Not any particular game character. */
export function PixelFace({ name, size = 32, title }: { name: string; size?: number; title?: string }) {
  let h = hash(name || '?');
  const pick = <T,>(arr: T[]) => {
    const v = arr[h % arr.length];
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return v;
  };
  const skin = pick(SKINS);
  const hair = pick(HAIRS);
  const eye = pick(EYES);
  const hat = pick(HATS);
  const style = h % 5;
  h = Math.imul(h, 2654435761) >>> 0;
  const beard = h % 4 === 0;

  const rows: string[] = [];
  const top = style === 4 ? ['TTTTTTTT', 'TTTTTTTT'] : style === 3 ? ['hhhhhhhh', 'hsshhssh'] : ['hhhhhhhh', 'hhhhhhhh'];
  rows.push(...top);
  rows.push(style === 1 ? 'hsssssshh'.slice(0, 8) : style === 2 ? 'hhsssshh' : 'hssssssh');
  rows.push('ssssssss');
  rows.push('swessews');
  rows.push('ssssssss');
  rows.push(beard ? 'shhmmhhs' : 'ssmmmmss');
  rows.push(beard ? 'shhhhhhs' : 'ssssssss');
  const pal: Record<string, string> = { h: hair, s: skin, w: '#ffffff', e: eye, m: '#7a3b2e', T: hat };
  return <PixelGrid grid={rows} palette={pal} size={size} title={title ?? name} />;
}

/** Discord avatar if we have one, otherwise the pixel face. */
export function Avatar({ name, url, size = 32 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={size} height={size} style={{ imageRendering: 'pixelated', boxShadow: '0 0 0 3px #07060d' }} referrerPolicy="no-referrer" />;
  }
  return (
    <span style={{ display: 'inline-block', boxShadow: '0 0 0 3px #07060d', lineHeight: 0 }}>
      <PixelFace name={name} size={size} />
    </span>
  );
}

// ---------------------------------------------------------------- world blocks
const BLOCKS: Record<string, { grid: Grid; pal: Record<string, string> }> = {
  grass: { grid: ['gggggggg', 'gGgggGgg', 'gdgGdgdg', 'dddddddd', 'ddDdddDd', 'dddDdddd', 'dDddddDd', 'dddddDdd'], pal: { g: '#6fd157', G: '#4fae3a', d: '#8a5a3b', D: '#6b432a' } },
  desert: { grid: ['ssssssss', 'sSsssSss', 'sssssss.', 'ssSsssss', 'ssssSsss', 'sSssssSs', 'ssssssss', 'sssSssss'].map((r) => r.replace('.', 's')), pal: { s: '#ecd28c', S: '#d1b46a' } },
  snow: { grid: ['wwwwwwww', 'wWwwwWww', 'wwwwwwww', 'iiwiiwii', 'iIiiiiIi', 'iiiIiiii', 'iIiiiiii', 'iiiiiIii'], pal: { w: '#f7fbff', W: '#d7e6f5', i: '#9fc8e8', I: '#7aa9d1' } },
  cherry: { grid: ['pppPpppp', 'pPpppPpp', 'ppppppPp', 'PpppPppp', 'bbbbbbbb', 'bBbbbBbb', 'bbbBbbbb', 'bBbbbbBb'], pal: { p: '#f6a7c8', P: '#e57aa8', b: '#5b3a4a', B: '#46293a' } },
  nether: { grid: ['rrRrrrrR', 'rRrrRrrr', 'rrrrrRrr', 'RrrRrrrr', 'rrrrrrRr', 'rRrrRrrr', 'rrrrrrrr', 'RrRrrRrr'], pal: { r: '#8f2a2a', R: '#6b1d1f' } },
  end: { grid: ['eeeeEeee', 'eEeeeeee', 'eeeePeee', 'eeEeeeEe', 'ePeeeeee', 'eeeeEeee', 'eEeeeePe', 'eeeeeeee'], pal: { e: '#e8e4a6', E: '#cfc98a', P: '#b88dff' } },
  ocean: { grid: ['wwWwwwWw', 'WwwwWwww', 'bbbbbbbb', 'bBbbbBbb', 'bbbbbbbb', 'bbBbbbbB', 'bbbbBbbb', 'Bbbbbbbb'], pal: { w: '#9ff0f5', W: '#5fe3e8', b: '#2c6fd1', B: '#1f55a6' } },
  mushroom: { grid: ['rrrrrrrr', 'rwrrrwrr', 'rrrrrrrr', 'rrrwrrrw', 'wrrrrrrr', 'rrrrwrrr', 'rwrrrrrr', 'rrrrrrwr'], pal: { r: '#d6403a', w: '#f4ecd8' } },
};

export function WorldBlock({ theme, size = 40 }: { theme: string; size?: number }) {
  const b = BLOCKS[theme] || BLOCKS.grass;
  return (
    <span style={{ display: 'inline-block', lineHeight: 0, boxShadow: '0 0 0 3px #07060d, 4px 4px 0 3px #0006' }}>
      <PixelGrid grid={b.grid} palette={b.pal} size={size} title={`${theme} world`} />
    </span>
  );
}

export const WORLD_THEMES = Object.keys(BLOCKS);

// ---------------------------------------------------------------- backdrop
export function Sky() {
  // Three layers of stepped hills, generated deterministically.
  const layer = (seed: number, base: number, amp: number, step: number) => {
    let h = seed;
    const pts: string[] = [`0,180`];
    let y = base;
    for (let x = 0; x <= 1600; x += step) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      y = Math.max(base - amp, Math.min(base + amp / 2, y + ((h >>> 16) % 3) * 8 - 8));
      pts.push(`${x},${y}`, `${x + step},${y}`);
    }
    pts.push('1600,180');
    return pts.join(' ');
  };
  return (
    <div className="sky" aria-hidden>
      <div className="stars" />
      <div className="stars two" />
      <div className="moon" />
      <div className="hills">
        <svg viewBox="0 0 1600 180" preserveAspectRatio="none" shapeRendering="crispEdges">
          <polygon points={layer(7, 70, 40, 48)} fill="#2a1f47" />
          <polygon points={layer(42, 110, 30, 32)} fill="#1f1736" />
          <polygon points={layer(99, 145, 18, 24)} fill="#140f24" />
        </svg>
      </div>
    </div>
  );
}
