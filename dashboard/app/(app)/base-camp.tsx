'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, useAgent, statusPace, timeAgo, duration, bytes } from '@/lib/client/api';
import { Avatar, WorldBlock, PixelFace } from '@/components/pixel';
import { CopyButton, TitleTag, useAction, Modal } from '@/components/ui';
import { useMe } from '@/components/me';

export type Status = {
  agent: { mode: string };
  server: {
    state: 'online' | 'offline' | 'starting' | 'stopping' | 'crashed';
    players: { online: number; max: number; names: string[] };
    mcVersion: string; software: string; pendingRestart: boolean; address: string;
    session: { world: string; startedBy: Mini | null; startedAt: string } | null;
  };
  activeWorld: { id: string; name: string; theme: string; host: Mini | null } | null;
  job: { id: string; label: string; step: string; by: Mini | null; startedAt: string } | null;
  lastJob: { id: string; label: string; ok: boolean; error?: string; finishedAt: string } | null;
  resources: { cpus: number; load1: number; memTotal: number; memAvailable: number; diskTotal: number; diskFree: number };
  queue: { id: string; userId: string; user: Mini | null; world: { id: string; name: string } | null; note: string; at: string }[];
};
type Mini = { id: string; name: string; title: string; titleTier: string; avatarUrl: string | null };

const STATE_TEXT: Record<string, string> = { online: 'ONLINE', offline: 'OFFLINE', starting: 'STARTING', stopping: 'STOPPING', crashed: 'CRASHED' };
const ACTIVITY: Record<string, string> = {
  'server.start': 'started the server', 'server.stop': 'stopped the server', 'server.restart': 'restarted the server',
  'world.create': 'created a world', 'world.activate': 'switched the server to', 'mods.install': 'added a mod to', 'mods.remove': 'removed a mod from',
  'pack.upload': 'uploaded a resource pack for', 'backup.create': 'backed up', 'world.reset': 'reset', 'world.restore': 'restored a backup of',
  'auth.join': 'joined the crew', 'users.whitelist': 'whitelisted a player',
};

export default function BaseCamp() {
  const me = useMe();
  const { data: s, error, reload } = useAgent<Status>('status', statusPace);
  const { data: activity } = useAgent<{ entries: any[] }>('activity', 30000);
  const { busy, run } = useAction();

  if (error && !s) return <div className="notice danger"><p>{error}</p></div>;
  if (!s) return <p className="muted">Loading base camp…</p>;

  const st = s.server.state;
  const running = st === 'online' || st === 'starting';
  const hostOfActive = s.activeWorld?.host?.id === me.user.id;
  const canStop = me.can.stop;
  const act = (path: string, label: string) => run(label, async () => {
    await api('POST', path);
    reload();
  }, `${label}…`);

  const memUsed = s.resources.memTotal - s.resources.memAvailable;
  const memPct = Math.round((memUsed / s.resources.memTotal) * 100);
  const cpuPct = Math.min(100, Math.round((s.resources.load1 / s.resources.cpus) * 100));
  const diskPct = s.resources.diskTotal ? Math.round(((s.resources.diskTotal - s.resources.diskFree) / s.resources.diskTotal) * 100) : 0;

  return (
    <>
      {s.agent.mode === 'mock' && (
        <div className="notice warn">
          <p><strong>Mock mode.</strong> This is a pretend server for testing the dashboard. Nothing here touches the real VM.</p>
        </div>
      )}

      <div className="grid two">
        <section className="panel" aria-labelledby="status-h">
          <h2 id="status-h" style={{ position: 'absolute', left: -9999 }}>Server status</h2>
          <div className="hero">
            <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
              <WorldBlock theme={s.activeWorld?.theme || 'grass'} size={96} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={`lamp ${st}`} />
                <span className={`state-word ${st}`}>{STATE_TEXT[st]}</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 19 }}>
                {s.activeWorld ? (
                  <>
                    <Link href={`/worlds/${s.activeWorld.id}`} style={{ color: 'var(--ink)', fontWeight: 600 }}>{s.activeWorld.name}</Link>
                    <span className="muted"> · hosted by {s.activeWorld.host?.name ?? 'nobody yet'}</span>
                  </>
                ) : (
                  <span className="muted">No world selected</span>
                )}
              </div>
              <div className="muted small" style={{ marginTop: 2 }}>
                Fabric {s.server.mcVersion} · {s.server.players.online} / {s.server.players.max || '–'} players
                {s.server.session && running && <> · up {duration(s.server.session.startedAt)}</>}
              </div>
              <div className="address" title="Put this in Multiplayer → Add Server">
                <code>{s.server.address}</code>
                <CopyButton text={s.server.address} />
              </div>
            </div>
          </div>

          {s.server.pendingRestart && running && (
            <div className="notice warn" style={{ marginTop: 16, marginBottom: 0 }}>
              <p>Changes are waiting for a restart (settings, mods or resource pack).{hostOfActive || canStop ? ' Restart when nobody is in the middle of something.' : ' Ask the host to restart.'}</p>
            </div>
          )}

          {s.job ? (
            <div style={{ marginTop: 18 }}>
              <div className="small" style={{ marginBottom: 6 }}>
                <span className="spin">✦</span> <strong>{s.job.label}</strong> <span className="muted">· {s.job.step}{s.job.by ? ` · by ${s.job.by.name}` : ''}</span>
              </div>
              <div className="bar busy warn"><i /></div>
            </div>
          ) : s.lastJob && !s.lastJob.ok && Date.now() - Date.parse(s.lastJob.finishedAt) < 10 * 60_000 ? (
            <div className="notice danger" style={{ marginTop: 16, marginBottom: 0 }}>
              <p><strong>{s.lastJob.label}</strong> failed: {s.lastJob.error}</p>
            </div>
          ) : null}

          <div className="btn-row" style={{ marginTop: 18 }}>
            {!running && (
              <button className="btn go big" disabled={!!s.job || !!busy || st === 'stopping'} onClick={() => act('server/start', 'Starting the server')}>
                ▶ START
              </button>
            )}
            {running && (
              <>
                <button className="btn warn" disabled={!!s.job || !!busy || !canStop} title={canStop ? '' : 'Only the host of this world or an admin can restart'} onClick={() => act('server/restart', 'Restarting')}>
                  ↻ RESTART
                </button>
                <button className="btn danger" disabled={!!s.job || !!busy || !canStop} title={canStop ? '' : 'Only the host of this world or an admin can stop'} onClick={() => act('server/stop', 'Stopping')}>
                  ■ STOP
                </button>
              </>
            )}
            <Link className="btn ghost" href="/worlds">SWITCH WORLD</Link>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>WHO&apos;S ON</h2>
            <span className="badge">{s.server.players.online} online</span>
          </div>
          {s.server.session && running ? (
            <p className="small muted" style={{ marginTop: -4 }}>
              Session started by <strong style={{ color: 'var(--ink)' }}>{s.server.session.startedBy?.name ?? 'someone'}</strong> {timeAgo(s.server.session.startedAt)}.
            </p>
          ) : null}
          {s.server.players.names.length ? (
            <ul className="rows">
              {s.server.players.names.map((n) => (
                <li key={n}>
                  <span style={{ boxShadow: '0 0 0 3px var(--edge)', lineHeight: 0 }}><PixelFace name={n} size={30} /></span>
                  <span className="grow mono">{n}</span>
                  <span className="badge go">PLAYING</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">
              <span className="big">{running ? 'NOBODY YET' : 'SERVER IS ASLEEP'}</span>
              {running ? 'Be the first one on!' : 'Press Start and it wakes up in about a minute.'}
            </div>
          )}
        </section>
      </div>

      <div className="grid three" style={{ marginTop: 18 }}>
        <QueueCard s={s} reload={reload} />
        <section className="panel">
          <div className="panel-head">
            <h2>SERVER HEALTH</h2>
            <span className="badge cool">FREE TIER</span>
          </div>
          <div className="meter"><span>CPU</span><div className={`bar ${cpuPct > 85 ? 'danger' : cpuPct > 60 ? 'warn' : ''}`}><i style={{ width: `${cpuPct}%` }} /></div><span className="val">{cpuPct}%</span></div>
          <div className="meter"><span>Memory</span><div className={`bar ${memPct > 90 ? 'danger' : memPct > 75 ? 'warn' : ''}`}><i style={{ width: `${memPct}%` }} /></div><span className="val">{bytes(memUsed)}</span></div>
          <div className="meter"><span>Disk</span><div className={`bar ${diskPct > 85 ? 'danger' : diskPct > 70 ? 'warn' : ''}`}><i style={{ width: `${diskPct}%` }} /></div><span className="val">{bytes(s.resources.diskFree)} free</span></div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {s.resources.cpus} CPU · {bytes(s.resources.memTotal)} RAM on Oracle&apos;s Always Free plan. It runs <strong style={{ color: 'var(--ink)' }}>one world at a time</strong>, so switching worlds kicks everyone to the new one.
          </p>
        </section>
        <section className="panel">
          <h2>CAMPFIRE LOG</h2>
          {activity?.entries?.length ? (
            <ul className="rows">
              {activity.entries.slice(0, 7).map((e, i) => (
                <li key={i} style={{ alignItems: 'flex-start' }}>
                  <Avatar name={e.actor?.name || '?'} url={e.actor?.avatarUrl} size={22} />
                  <span className="grow small">
                    <strong>{e.actor?.name || 'Someone'}</strong> {ACTIVITY[e.action] || e.action}
                    {e.world && !['world.create', 'auth.join', 'users.whitelist', 'server.start', 'server.stop', 'server.restart'].includes(e.action) ? <> <strong>{e.world.name}</strong></> : e.world && e.action === 'world.create' ? <>: <strong>{e.world.name}</strong></> : null}
                    <span className="muted"> · {timeAgo(e.ts)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">Quiet around the campfire.</div>
          )}
        </section>
      </div>
    </>
  );
}

function QueueCard({ s, reload }: { s: Status; reload: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const { data: worlds } = useAgent<{ worlds: { id: string; name: string; active: boolean }[] }>(open ? 'worlds' : null);
  const [worldId, setWorldId] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const mine = s.queue.find((q) => q.userId === me.user.id);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>NEXT UP</h2>
        <span className="badge">{s.queue.length} waiting</span>
      </div>
      {s.queue.length ? (
        <ul className="rows">
          {s.queue.map((q, i) => (
            <li key={q.id}>
              <span className="mono" style={{ color: 'var(--torch)', width: 22 }}>#{i + 1}</span>
              <Avatar name={q.user?.name || '?'} url={q.user?.avatarUrl} size={26} />
              <span className="grow">
                <strong>{q.user?.name}</strong> wants <strong>{q.world?.name}</strong>
                {q.note && <span className="muted small"> “{q.note}”</span>}
                <br />
                <span className="muted small">{timeAgo(q.at)}</span>
              </span>
              {(q.userId === me.user.id || me.user.role !== 'member') && (
                <button className="btn ghost sm" disabled={!!busy} onClick={() => run('leave', async () => { await api('DELETE', `queue/${q.id}`); reload(); }, 'Removed from the queue')}>✕</button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">Nobody waiting. The server is all yours.</div>
      )}
      {!mine && (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => setOpen(true)}>ASK FOR A TURN</button>
        </div>
      )}
      {open && (
        <Modal title="ASK FOR A TURN" onClose={() => setOpen(false)}>
          <p className="small muted" style={{ marginTop: 0 }}>Only one world can run at a time. Join the queue and the current host can switch when they&apos;re done.</p>
          <label className="field">
            <span>Which world?</span>
            <select className="input" value={worldId} onChange={(e) => setWorldId(e.target.value)}>
              <option value="">Pick a world…</option>
              {worlds?.worlds.filter((w) => !w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input className="input" maxLength={80} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. after 8pm?" />
          </label>
          <button className="btn go" disabled={!worldId || !!busy} onClick={() => run('join', async () => { await api('POST', 'queue', { worldId, note }); setOpen(false); reload(); }, "You're in the queue")}>JOIN QUEUE</button>
        </Modal>
      )}
    </section>
  );
}
