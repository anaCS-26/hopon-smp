'use client';
import { useAgent, timeAgo } from '@/lib/client/api';
import { Avatar } from '@/components/pixel';
import { useMe } from '@/components/me';

type Entry = { ts: string; actor: string; actorUser: { name: string; avatarUrl: string | null } | null; action: string; target?: string; result: string; reason?: string; details?: Record<string, unknown> };

export default function AuditPage() {
  const me = useMe();
  const { data, error } = useAgent<{ entries: Entry[] }>(me.can.audit ? 'audit?limit=300' : null, 15000);
  if (!me.can.audit) return <div className="notice" style={{ marginTop: 20 }}><p>The logbook is for admins and the Team Leader.</p></div>;

  return (
    <>
      <h1 className="page-title">LOGBOOK</h1>
      <p className="page-sub">Every change made through the dashboard, and every attempt that was refused. It&apos;s stored on the server and can&apos;t be edited or deleted from here.</p>
      {error && <div className="notice danger"><p>{error}</p></div>}
      <section className="panel">
        <table className="plain">
          <thead><tr><th>WHEN</th><th>WHO</th><th>WHAT</th><th>RESULT</th></tr></thead>
          <tbody>
            {data?.entries.map((e, i) => (
              <tr key={i}>
                <td className="small" title={e.ts}>{timeAgo(e.ts)}</td>
                <td className="small">
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {e.actorUser && <Avatar name={e.actorUser.name} url={e.actorUser.avatarUrl} size={18} />}
                    {e.actorUser?.name || e.actor}
                  </span>
                </td>
                <td>
                  <span className="mono" style={{ fontSize: 18 }}>{e.action}</span>
                  {e.target && <span className="muted small"> → {e.target}</span>}
                  {e.details && <div className="small muted" style={{ wordBreak: 'break-word' }}>{JSON.stringify(e.details).slice(0, 160)}</div>}
                </td>
                <td>
                  {e.result === 'ok' ? <span className="badge go">OK</span> : e.result === 'denied' ? <span className="badge danger" title={e.reason}>DENIED</span> : <span className="badge warn" title={e.reason}>{e.result.toUpperCase()}</span>}
                  {e.reason && <div className="small muted">{e.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.entries.length === 0 && <div className="empty">Nothing logged yet.</div>}
      </section>
    </>
  );
}
