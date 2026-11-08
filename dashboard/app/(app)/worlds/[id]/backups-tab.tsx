'use client';
import { useCallback, useRef, useState } from 'react';
import { api, useAgent, bytes, timeAgo } from '@/lib/client/api';
import { useAction, useJobWatcher, TypeToConfirm } from '@/components/ui';
import type { World } from '../types';

type Backup = { id: string; size: number; worldId: string; kind: string; at: string };
const KIND: Record<string, string> = {
  auto: 'Automatic (every 6 h)', manual: 'Manual', predelete: 'Before delete', prereset: 'Before reset', prerestore: 'Before restore',
  premodremove: 'Before removing a mod', preupgrade: 'Before version upgrade', 'pre-setup': 'Before server setup', 'pre-migrate': 'Before migration',
};

export function BackupsTab({ w, canBackup, canRestore, reload }: { w: World; canBackup: boolean; canRestore: boolean; reload: () => void }) {
  const { data, reload: reloadList } = useAgent<{ backups: Backup[] }>(`worlds/${w.id}/backups`, 10000);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const { busy, run } = useAction();
  const r1 = useRef(reload);
  r1.current = reload;
  const { watch, watching } = useJobWatcher(useCallback(() => { r1.current(); reloadList(); }, [reloadList]));

  return (
    <div className="grid two">
      <section className="panel">
        <div className="panel-head">
          <h2>BACKUPS <span className="hint">{data?.backups.length ?? '…'} saved</span></h2>
          {canBackup && (
            <button className="btn go sm" disabled={!!busy || !!watching} onClick={() => run('bk', async () => { const r = await api('POST', `worlds/${w.id}/backups`); watch(r.job.id); }, 'Backing up…')}>
              BACK UP NOW
            </button>
          )}
        </div>
        {watching && <div className="bar busy" style={{ marginBottom: 12 }}><i /></div>}
        {data?.backups.length ? (
          <table className="plain">
            <thead><tr><th>WHEN</th><th>WHY</th><th>SIZE</th><th /></tr></thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.at).toLocaleString()}<br /><span className="small muted">{timeAgo(b.at)}</span></td>
                  <td>{KIND[b.kind] || b.kind}</td>
                  <td className="mono">{bytes(b.size)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {canRestore && <button className="btn warn sm" disabled={!!busy || !!watching} onClick={() => setRestoring(b)}>RESTORE</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{data ? 'No backups yet for this world.' : 'Loading…'}</div>
        )}
      </section>
      <section className="panel">
        <h2>HOW BACKUPS WORK</h2>
        <ul className="rows">
          <li>The running world is backed up automatically every 6 hours. The last week of automatic backups is kept.</li>
          <li>Manual backups and the ones taken before risky actions are kept until the Team Leader cleans up.</li>
          <li>Restoring first takes a fresh backup of the world as it is now, so a restore can be undone.</li>
          <li>Backups live on the server&apos;s disk. The Team Leader copies important ones off the server too.</li>
        </ul>
        {!canRestore && <p className="small muted">Only this world&apos;s host (or the Team Leader) can restore.</p>}
      </section>
      {restoring && (
        <TypeToConfirm word={w.name} action="RESTORE THIS BACKUP" danger={false} onClose={() => setRestoring(null)}
          onConfirm={(typed) => run('restore', async () => { const r = await api('POST', `worlds/${w.id}/restore`, { backupId: restoring.id, confirm: typed }); setRestoring(null); watch(r.job.id); }, 'Restoring…')}>
          <p className="small">
            {w.name} goes back to how it was <strong>{timeAgo(restoring.at)}</strong>. Anything built since then is replaced (a backup of the current state is taken first).
            {w.active && ' The server restarts, so players get kicked for a minute.'}
          </p>
        </TypeToConfirm>
      )}
    </div>
  );
}
