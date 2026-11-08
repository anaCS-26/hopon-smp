'use client';
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { useAction, useJobWatcher, TypeToConfirm } from '@/components/ui';
import { SettingField } from '../setting-field';
import type { World, SettingSpec } from '../types';

export function DangerTab({ w, schema, canReset, canDelete }: { w: World; schema: SettingSpec[]; canReset: boolean; canDelete: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<'reset' | 'delete' | null>(null);
  const [fresh, setFresh] = useState<Record<string, any>>({ 'level-seed': '', 'level-type': w.settings['level-type'], hardcore: w.settings.hardcore, 'generate-structures': w.settings['generate-structures'] });
  const { busy, run } = useAction();
  const { watch, watching } = useJobWatcher(useCallback((job: any) => job.ok && job.kind === 'world.delete' && router.push('/worlds'), [router]));
  const specs = schema.filter((s) => s.createOnly);

  if (!canReset && !canDelete) {
    return <div className="notice"><p>Only {w.name}&apos;s host (or the Team Leader) can reset or delete this world.</p></div>;
  }

  return (
    <div className="grid two">
      <section className="panel">
        <h2>RESET THE WORLD</h2>
        <p>Starts a brand-new map with the same name, settings and mods. The old map goes into a backup first, and also into the server&apos;s trash folder.</p>
        {specs.map((s) => (
          <SettingField key={s.key} spec={s} value={fresh[s.key]} disabled={!canReset} onChange={(v) => setFresh((f) => ({ ...f, [s.key]: v }))} />
        ))}
        <button className="btn warn" disabled={!canReset || !!busy || !!watching} onClick={() => setMode('reset')}>RESET {w.name.toUpperCase()}</button>
      </section>
      <section className="panel">
        <h2>DELETE THE WORLD</h2>
        <p>Removes {w.name} from the list. A final backup is taken, and the files are moved to the server&apos;s trash (only the Team Leader can empty it), so a mistake can still be fixed.</p>
        {w.active && <div className="notice warn"><p>This world is running. Switch to another world before deleting it.</p></div>}
        <button className="btn danger" disabled={!canDelete || w.active || !!busy || !!watching} onClick={() => setMode('delete')}>DELETE {w.name.toUpperCase()}</button>
      </section>
      {watching && <div className="bar busy danger" style={{ gridColumn: '1 / -1' }}><i /></div>}
      {mode === 'reset' && (
        <TypeToConfirm word={w.name} action="RESET WORLD" onClose={() => setMode(null)}
          onConfirm={(typed) => run('reset', async () => {
            const settings = Object.fromEntries(Object.entries(fresh).filter(([, v]) => v !== '' && v !== undefined));
            const r = await api('POST', `worlds/${w.id}/reset`, { confirm: typed, settings });
            setMode(null);
            watch(r.job.id);
          }, 'Backing up, then resetting…')}>
          <p className="small">Everything built in {w.name} is replaced by a fresh map. A backup is taken first.</p>
        </TypeToConfirm>
      )}
      {mode === 'delete' && (
        <TypeToConfirm word={w.name} action="DELETE WORLD" onClose={() => setMode(null)}
          onConfirm={(typed) => run('delete', async () => { const r = await api('POST', `worlds/${w.id}/delete`, { confirm: typed }); setMode(null); watch(r.job.id); }, 'Backing up, then deleting…')}>
          <p className="small">{w.name} disappears from the dashboard. A backup is kept on the server.</p>
        </TypeToConfirm>
      )}
    </div>
  );
}
