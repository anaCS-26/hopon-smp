'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { WorldBlock, WORLD_THEMES } from '@/components/pixel';
import { useAction } from '@/components/ui';
import { SettingField } from '../setting-field';
import type { World, SettingSpec } from '../types';

const GROUPS: [string, string[]][] = [
  ['GAMEPLAY', ['gamemode', 'force-gamemode', 'difficulty', 'pvp', 'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-animals', 'spawn-npcs', 'enable-command-block']],
  ['SERVER', ['motd', 'max-players', 'view-distance', 'simulation-distance', 'spawn-protection', 'player-idle-timeout', 'hide-online-players', 'max-world-size', 'require-resource-pack']],
];

export function SettingsTab({ w, schema, canEdit, reload }: { w: World; schema: SettingSpec[]; canEdit: boolean; reload: () => void }) {
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [meta, setMeta] = useState({ name: w.name, description: w.description, theme: w.theme });
  const { busy, run } = useAction();
  useEffect(() => setMeta({ name: w.name, description: w.description, theme: w.theme }), [w.name, w.description, w.theme]);

  const value = (k: string) => (k in draft ? draft[k] : w.settings[k]);
  const changed = Object.keys(draft).filter((k) => draft[k] !== w.settings[k]);
  const byKey = Object.fromEntries(schema.map((s) => [s.key, s]));

  const save = () =>
    run('save', async () => {
      const settings = Object.fromEntries(changed.map((k) => [k, draft[k]]));
      const r = await api('PATCH', `worlds/${w.id}/settings`, { settings });
      setDraft({});
      reload();
      return r;
    }, (r: any) => (r?.restartNeeded ? 'Saved. Restart the server to apply.' : 'Saved. Applies next time this world starts.'));

  return (
    <>
      {!canEdit && <div className="notice"><p>You can look, but only this world&apos;s host or an admin can change settings.</p></div>}
      <div className="grid three">
        {GROUPS.map(([title, keys]) => (
          <section className="panel" key={title}>
            <h2>{title}</h2>
            {keys.filter((k) => byKey[k]).map((k) => (
              <SettingField key={k} spec={byKey[k]} value={value(k)} disabled={!canEdit} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} />
            ))}
          </section>
        ))}
        <section className="panel">
          <h2>NAME &amp; LOOK</h2>
          <label className="field"><span>Name</span><input className="input" maxLength={32} value={meta.name} disabled={!canEdit} onChange={(e) => setMeta({ ...meta, name: e.target.value })} /></label>
          <label className="field"><span>Description</span><input className="input" maxLength={140} value={meta.description} disabled={!canEdit} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></label>
          <div className="btn-row" style={{ marginBottom: 14 }}>
            {WORLD_THEMES.map((t) => (
              <button key={t} type="button" disabled={!canEdit} onClick={() => setMeta({ ...meta, theme: t })} aria-pressed={meta.theme === t}
                style={{ background: 'none', border: 0, padding: 4, cursor: 'pointer', outline: meta.theme === t ? '3px solid var(--torch)' : 'none' }}>
                <WorldBlock theme={t} size={26} />
              </button>
            ))}
          </div>
          <button className="btn sm" disabled={!canEdit || !!busy || (meta.name === w.name && meta.description === w.description && meta.theme === w.theme)}
            onClick={() => run('meta', async () => { await api('PATCH', `worlds/${w.id}`, meta); reload(); }, 'Updated')}>
            SAVE NAME &amp; LOOK
          </button>
          <hr />
          <h3>LOCKED SETTINGS</h3>
          <p className="small muted" style={{ marginTop: 0 }}>
            Seed <span className="mono">{String(w.settings['level-seed'] || 'random')}</span>, world type and hardcore were fixed when the world was made. Change them with a reset (Danger Zone).
            Security settings (online mode, whitelist, RCON) are locked for every world.
          </p>
        </section>
      </div>
      {canEdit && (
        <div className="btn-row" style={{ marginTop: 18, position: 'sticky', bottom: 14 }}>
          <button className="btn go" disabled={!changed.length || !!busy} onClick={save}>
            SAVE {changed.length ? `${changed.length} CHANGE${changed.length > 1 ? 'S' : ''}` : 'SETTINGS'}
          </button>
          {changed.length > 0 && <button className="btn ghost" onClick={() => setDraft({})}>UNDO</button>}
          {w.active && changed.length > 0 && <span className="small muted">This world is running: changes apply after a restart.</span>}
        </div>
      )}
    </>
  );
}
