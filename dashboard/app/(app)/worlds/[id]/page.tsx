'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { useAgent, timeAgo } from '@/lib/client/api';
import { WorldBlock, Avatar } from '@/components/pixel';
import { TitleTag } from '@/components/ui';
import type { World, SettingSpec } from '../types';
import { OverviewTab } from './overview-tab';
import { SettingsTab } from './settings-tab';
import { ModsTab } from './mods-tab';
import { PackTab } from './pack-tab';
import { BackupsTab } from './backups-tab';
import { DangerTab } from './danger-tab';

const TABS = [
  ['overview', 'OVERVIEW'],
  ['settings', 'SETTINGS'],
  ['mods', 'MOD SHOP'],
  ['pack', 'RESOURCE PACK'],
  ['backups', 'BACKUPS'],
  ['danger', 'DANGER ZONE'],
] as const;

export default function WorldPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const tab = (sp.get('tab') as (typeof TABS)[number][0]) || 'overview';
  const { data, error, reload } = useAgent<{ world: World; schema: SettingSpec[] }>(`worlds/${id}`, 6000);
  // Plain history update: Next's router keeps useSearchParams in sync, and switching tabs doesn't
  // wait for a server round trip the way router.replace does.
  const setTab = useCallback((t: string) => window.history.replaceState(null, '', `/worlds/${id}${t === 'overview' ? '' : `?tab=${t}`}`), [id]);

  if (error && !data) return <div className="notice danger" style={{ marginTop: 20 }}><p>{error} · <Link href="/worlds">back to worlds</Link></p></div>;
  if (!data) return <p className="muted">Loading world…</p>;
  const w = data.world;
  const can = w.can || {};

  return (
    <>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', margin: '22px 0 14px', flexWrap: 'wrap' }}>
        <WorldBlock theme={w.theme} size={64} />
        <div className="grow">
          <h1 className="page-title" style={{ margin: 0 }}>
            {w.name} {w.active && <span className="badge go" style={{ verticalAlign: 'middle' }}>ACTIVE WORLD</span>}
          </h1>
          <div className="small muted" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Avatar name={w.host?.name || '?'} url={w.host?.avatarUrl} size={20} />
            Hosted by <strong style={{ color: 'var(--ink)' }}>{w.host?.name ?? 'nobody'}</strong> <TitleTag title={w.host?.title} tier={w.host?.titleTier} />
            <span>· made {timeAgo(w.createdAt)} on {w.createdVersion}</span>
          </div>
        </div>
        <Link href="/worlds" className="btn ghost sm">← ALL WORLDS</Link>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab w={w} reload={reload} />}
      {tab === 'settings' && <SettingsTab w={w} schema={data.schema} canEdit={!!can['world.settings']} reload={reload} />}
      {tab === 'mods' && <ModsTab w={w} canManage={!!can['mods.manage']} reload={reload} />}
      {tab === 'pack' && <PackTab w={w} canManage={!!can['pack.manage']} reload={reload} />}
      {tab === 'backups' && <BackupsTab w={w} canBackup={!!can['backup.create']} canRestore={!!can['world.restore']} reload={reload} />}
      {tab === 'danger' && <DangerTab w={w} schema={data.schema} canReset={!!can['world.reset']} canDelete={!!can['world.delete']} />}
    </>
  );
}
