'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, useAgent, bytes, timeAgo } from '@/lib/client/api';
import { useAction, useJobWatcher, Modal, TypeToConfirm } from '@/components/ui';
import type { World, Mod } from '../types';

type Hit = { projectId: string; slug: string; title: string; description: string; author: string; downloads: number; iconUrl: string | null; clientSide: string; serverSide: string; updated: string; url: string; license: string };

function sideBadge(clientSide: string | null) {
  if (clientSide === 'required') return <span className="badge warn" title="Every player must install this mod too">EVERYONE NEEDS IT</span>;
  if (clientSide === 'optional') return <span className="badge cool" title="Works server-only; players can optionally install it for extras">SERVER · PLAYERS OPTIONAL</span>;
  if (clientSide === 'unsupported') return <span className="badge go" title="Only the server needs it">SERVER ONLY</span>;
  return null;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function ModIcon({ url, title }: { url?: string | null; title: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" width={40} height={40} style={{ boxShadow: '0 0 0 3px var(--edge)', flex: 'none' }} referrerPolicy="no-referrer" loading="lazy" /> : (
    <span style={{ width: 40, height: 40, flex: 'none', display: 'grid', placeItems: 'center', background: 'var(--stone-2)', boxShadow: '0 0 0 3px var(--edge)', fontFamily: 'var(--font-display)', fontSize: 14 }}>{title[0]}</span>
  );
}

export function ModsTab({ w, canManage, reload }: { w: World; canManage: boolean; reload: () => void }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Mod | null>(null);
  const { data: results, error, loading } = useAgent<{ hits: Hit[]; total: number; mcVersion: string; starterPicks: { slug: string; why: string }[] }>(`mods/search?q=${encodeURIComponent(query)}`);
  const { busy, run } = useAction();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const { watch, watching } = useJobWatcher(useCallback(() => reloadRef.current(), []));

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const installedIds = new Set(w.mods.map((m) => m.projectId || m.slug));

  return (
    <>
      <div className="notice">
        <p>
          <strong>How mods work here:</strong> mods come only from <a href="https://modrinth.com" target="_blank" rel="noopener noreferrer">Modrinth</a>, a trusted mod site, and only versions made for Fabric {results?.mcVersion}. The server checks each download&apos;s fingerprint (sha512) before installing. Uploading your own .jar files isn&apos;t allowed: mods are programs, and a bad one could take over the server.
          {' '}New to mods? Read <Link href="/guides#mods">Guides → What are mods?</Link>
        </p>
      </div>

      <div className="grid two">
        <section className="panel">
          <div className="panel-head">
            <h2>MOD SHOP</h2>
            <span className="badge">FABRIC {results?.mcVersion}</span>
          </div>
          <input className="input" placeholder="Search Modrinth: graves, chunky, voice chat…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search mods" />
          {error && <div className="notice danger" style={{ marginTop: 12 }}><p>{error}</p></div>}

          {!query && results?.starterPicks?.length ? (
            <>
              <h3 style={{ marginTop: 18 }}>GOOD STARTER PICKS</h3>
              <ul className="rows">
                {results.starterPicks.map((p) => (
                  <li key={p.slug}>
                    <span className="grow"><strong>{p.slug}</strong><br /><span className="small muted">{p.why}</span></span>
                    <button className="btn sm" onClick={() => setPicked(p.slug)}>VIEW</button>
                  </li>
                ))}
              </ul>
              <h3 style={{ marginTop: 18 }}>MOST DOWNLOADED</h3>
            </>
          ) : null}

          {loading && <p className="muted">Searching…</p>}
          <ul className="rows">
            {results?.hits.map((h) => (
              <li key={h.projectId} style={{ alignItems: 'flex-start' }}>
                <ModIcon url={h.iconUrl} title={h.title} />
                <span className="grow">
                  <strong>{h.title}</strong> <span className="muted small">by {h.author}</span>
                  <br />
                  <span className="small" style={{ color: 'var(--ink-2)' }}>{h.description}</span>
                  <br />
                  <span className="small muted">⬇ {fmt(h.downloads)} · updated {timeAgo(h.updated)}</span> {sideBadge(h.clientSide)}
                </span>
                {installedIds.has(h.projectId) ? <span className="badge go">INSTALLED</span> : <button className="btn sm" onClick={() => setPicked(h.projectId)}>VIEW</button>}
              </li>
            ))}
          </ul>
          {results && results.hits.length === 0 && <div className="empty">No Fabric {results.mcVersion} mods match that. Some mods aren&apos;t updated for new versions yet.</div>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>INSTALLED <span className="hint">{w.mods.length} mods</span></h2>
            {w.active && <span className="badge warn">RESTART TO APPLY</span>}
          </div>
          {watching && <div className="bar busy warn" style={{ marginBottom: 12 }}><i /></div>}
          <ul className="rows">
            {w.mods.map((m) => (
              <li key={m.filename} style={{ alignItems: 'flex-start' }}>
                <ModIcon url={m.iconUrl} title={m.title || m.slug} />
                <span className="grow">
                  <strong>{m.title || m.slug}</strong> <span className="muted small mono">{m.versionNumber}</span>
                  <br />
                  {m.protected ? <span className="badge epic" title="Keeps the server safe; can't be removed">PROTECTED</span> : null} {sideBadge(m.clientSide)}
                  {m.size ? <span className="small muted"> {bytes(m.size)}</span> : null}
                </span>
                {canManage && !m.protected && (
                  <button className="btn ghost sm" disabled={!!busy || !!watching} onClick={() => setRemoving(m)} title="Remove (a backup is taken first)">✕</button>
                )}
              </li>
            ))}
          </ul>
          <p className="small muted">Removing a mod takes a backup first, because removing some mods can delete their blocks or items from the world.</p>
        </section>
      </div>

      {picked && (
        <ProjectModal
          projectId={picked}
          canManage={canManage}
          onClose={() => setPicked(null)}
          onInstall={(versionId, title) =>
            run('install', async () => {
              const r = await api('POST', `worlds/${w.id}/mods`, { versionId });
              setPicked(null);
              watch(r.job.id);
            }, `Installing ${title} (checking its fingerprint)…`)
          }
        />
      )}
      {removing && (
        <TypeToConfirm word={removing.slug} action={`REMOVE ${removing.title?.toUpperCase() || removing.slug}`} onClose={() => setRemoving(null)}
          onConfirm={() => run('remove', async () => { const r = await api('DELETE', `worlds/${w.id}/mods/${removing.projectId || removing.slug}`); setRemoving(null); watch(r.job.id); }, 'Backing up, then removing…')}>
          <p className="small">A backup of <strong>{w.name}</strong> is taken first. Blocks or items added by this mod may disappear from the world.</p>
        </TypeToConfirm>
      )}
    </>
  );
}

function ProjectModal({ projectId, canManage, onClose, onInstall }: { projectId: string; canManage: boolean; onClose: () => void; onInstall: (versionId: string, title: string) => void }) {
  const { data, error } = useAgent<{ project: any; versions: any[]; mcVersion: string }>(`mods/project/${projectId}`);
  const [versionId, setVersionId] = useState('');
  useEffect(() => {
    if (data?.versions?.length) setVersionId((data.versions.find((v) => v.type === 'release') || data.versions[0]).versionId);
  }, [data]);
  const p = data?.project;

  return (
    <Modal title={p?.title?.toUpperCase() || 'MOD'} onClose={onClose}>
      {error && <div className="notice danger"><p>{error}</p></div>}
      {!data && !error && <p className="muted">Asking Modrinth…</p>}
      {p && (
        <>
          <p style={{ marginTop: 0 }}>{p.description}</p>
          <p className="small">
            {sideBadge(p.clientSide)} <span className="muted">· ⬇ {fmt(p.downloads)} · license {p.license || '?'}</span>
          </p>
          {p.clientSide === 'required' && (
            <div className="notice warn"><p>Every player will need to install this mod on their own game too, or they can&apos;t join this world.</p></div>
          )}
          <p className="small">
            <a href={p.url} target="_blank" rel="noopener noreferrer">Open on Modrinth ↗</a>
            {p.sourceUrl && <> · <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">Source code ↗</a></>}
          </p>
          {data.versions.length === 0 ? (
            <div className="notice danger"><p>No Fabric build for Minecraft {data.mcVersion} yet. Check back later.</p></div>
          ) : (
            <>
              <label className="field">
                <span>Version (newest first)</span>
                <select className="input" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                  {data.versions.map((v) => (
                    <option key={v.versionId} value={v.versionId}>
                      {v.versionNumber} · {v.type}{v.file ? ` · ${bytes(v.file.size)}` : ''}{v.requiredDeps.length ? ` · needs ${v.requiredDeps.length} other mod(s)` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="small muted">Mods it needs are installed automatically, checked the same way.</p>
              <button className="btn go" disabled={!canManage || !versionId} onClick={() => onInstall(versionId, p.title)}>
                {canManage ? 'INSTALL ON THIS WORLD' : "ONLY THE HOST CAN INSTALL"}
              </button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
