'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api, useAgent } from '@/lib/client/api';
import { WorldBlock, WORLD_THEMES } from '@/components/pixel';
import { useAction, useJobWatcher } from '@/components/ui';
import { SettingField } from '../setting-field';
import type { SettingSpec } from '../types';

const CREATE_KEYS = ['gamemode', 'difficulty', 'level-type', 'level-seed', 'hardcore', 'generate-structures', 'pvp'];

export default function NewWorldPage() {
  const router = useRouter();
  const { data } = useAgent<{ schema: SettingSpec[] }>('worlds');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState('grass');
  const [settings, setSettings] = useState<Record<string, any>>({
    gamemode: 'survival', difficulty: 'normal', 'level-type': 'minecraft:normal', 'level-seed': '', hardcore: false, 'generate-structures': true, pvp: true,
  });
  const { busy, run } = useAction();
  const onDone = useCallback((job: any) => job.ok && job.result?.worldId && router.push(`/worlds/${job.result.worldId}`), [router]);
  const { watch, watching } = useJobWatcher(onDone);

  const specs = (data?.schema || []).filter((s) => CREATE_KEYS.includes(s.key));
  const submit = () =>
    run('create', async () => {
      const r = await api('POST', 'worlds', { name, description, theme, settings });
      watch(r.job.id);
    }, 'Building your world… (installing the safe starter mods)');

  return (
    <>
      <h1 className="page-title">NEW WORLD</h1>
      <p className="page-sub">You&apos;ll be the host of this world. It starts with the four safety and speed mods (Fabric API, EasyAuth, Lithium, FerriteCore); you can add more later from the Mod Shop.</p>
      <div className="grid two">
        <section className="panel">
          <label className="field">
            <span>World name</span>
            <input className="input" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frog Kingdom" />
          </label>
          <label className="field">
            <span>Short description (optional)</span>
            <input className="input" maxLength={140} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's the plan for this world?" />
          </label>
          <div className="field">
            <span style={{ display: 'block', fontSize: 15, color: 'var(--ink-2)', marginBottom: 8 }}>Pick a block (just for looks)</span>
            <div className="btn-row">
              {WORLD_THEMES.map((t) => (
                <button key={t} type="button" onClick={() => setTheme(t)} aria-pressed={theme === t} title={t}
                  style={{ background: 'none', border: 0, padding: 6, cursor: 'pointer', outline: theme === t ? '3px solid var(--torch)' : 'none' }}>
                  <WorldBlock theme={t} size={34} />
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="panel">
          <h2>HOW IT PLAYS</h2>
          {specs.map((s) => (
            <SettingField key={s.key} spec={s} value={settings[s.key]} onChange={(v) => setSettings((x) => ({ ...x, [s.key]: v }))} />
          ))}
          <p className="small muted">Seed, world type, structures and hardcore can only be picked now (or when resetting the world).</p>
        </section>
      </div>
      <div className="btn-row" style={{ marginTop: 18 }}>
        <button className="btn go big" disabled={name.trim().length < 3 || !!busy || !!watching} onClick={submit}>
          {watching ? 'BUILDING…' : 'CREATE WORLD'}
        </button>
        <button className="btn ghost" onClick={() => router.push('/worlds')}>CANCEL</button>
      </div>
    </>
  );
}
