'use client';
import Link from 'next/link';
import { useAgent, timeAgo } from '@/lib/client/api';
import { WorldBlock, Avatar } from '@/components/pixel';
import { useMe } from '@/components/me';
import type { World } from './types';

export default function WorldsPage() {
  const me = useMe();
  const { data, error } = useAgent<{ worlds: World[]; limits: { perUser: number | null } }>('worlds', 5000);
  const mine = data?.worlds.filter((w) => w.host?.id === me.user.id).length ?? 0;
  const limit = data?.limits.perUser;

  return (
    <>
      <div className="panel-head" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="page-title">WORLDS</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            Every world has a <strong>host</strong>: whoever made it. Hosts run their world&apos;s settings, mods and backups. Only one world runs at a time.
          </p>
        </div>
        <Link className="btn go" href="/worlds/new" aria-disabled={limit != null && mine >= limit}>
          + NEW WORLD
        </Link>
      </div>
      {limit != null && <p className="small muted">You host {mine} of {limit} worlds you&apos;re allowed.</p>}
      {error && <div className="notice danger"><p>{error}</p></div>}
      {!data && !error && <p className="muted">Loading worlds…</p>}

      <div className="grid cards" style={{ marginTop: 14 }}>
        {data?.worlds.map((w) => (
          <Link key={w.id} href={`/worlds/${w.id}`} className={`panel world-card ${w.active ? 'active' : ''}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="top">
              <WorldBlock theme={w.theme} size={48} />
              <div className="grow">
                <h3 style={{ lineHeight: 1.5 }}>{w.name}</h3>
                <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Avatar name={w.host?.name || '?'} url={w.host?.avatarUrl} size={18} /> {w.host?.name ?? 'no host'}
                </div>
              </div>
              {w.active ? <span className="badge go" title="The world the server loads">ACTIVE</span> : w.host?.id === me.user.id ? <span className="badge warn">YOURS</span> : null}
            </div>
            <p className="desc">{w.description || <span className="muted">No description yet.</span>}</p>
            <div className="stats">
              <span>⛏ {w.mods.length} mods</span>
              <span>⌛ {Math.round(w.playMinutes / 60)} h played</span>
              <span>{w.settings.gamemode}</span>
              <span>{w.active ? 'live now' : `last on ${timeAgo(w.lastActiveAt)}`}</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
