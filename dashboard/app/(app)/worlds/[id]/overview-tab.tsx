'use client';
import Link from 'next/link';
import { useRef, useCallback } from 'react';
import { api, useAgent } from '@/lib/client/api';
import { useAction, useJobWatcher } from '@/components/ui';
import type { World } from '../types';
import type { Status } from '../../base-camp';

export function OverviewTab({ w, reload }: { w: World; reload: () => void }) {
  const { data: s } = useAgent<Status>('status', 3000);
  const { busy, run } = useAction();
  const { watch, watching } = useJobWatcher(useCallbackOnce(reload));
  const clientMods = w.mods.filter((m) => m.clientSide === 'required');
  const players = s?.server.players.online ?? 0;
  const canSwitch = !!w.can?.['world.activate'];

  return (
    <div className="grid two">
      <section className="panel">
        <h2>{w.active ? 'THIS WORLD IS RUNNING' : 'PLAY THIS WORLD'}</h2>
        {w.active ? (
          <p>
            Everyone who joins <code className="mono" style={{ color: 'var(--gold)' }}>{s?.server.address}</code> lands here. Control the server from{' '}
            <Link href="/">Base Camp</Link>.
          </p>
        ) : (
          <>
            <p>
              Switching stops <strong>{s?.activeWorld?.name ?? 'the current world'}</strong> (it saves first) and starts <strong>{w.name}</strong>. Takes about a minute.
              {players > 0 && <> Right now <strong>{players} player{players === 1 ? ' is' : 's are'} online</strong>; they get a 30-second warning in chat.</>}
            </p>
            {!canSwitch && <div className="notice warn"><p>Only {w.name}&apos;s host or an admin can switch to it. Ask them, or join the queue on Base Camp.</p></div>}
            <button
              className="btn go big"
              disabled={!canSwitch || !!busy || !!watching || !!s?.job}
              onClick={() => run('switch', async () => { const r = await api('POST', `worlds/${w.id}/activate`); watch(r.job.id); }, `Switching to ${w.name}…`)}
            >
              {watching ? 'SWITCHING…' : `⇄ SWITCH TO ${w.name.toUpperCase()}`}
            </button>
          </>
        )}
        <hr />
        <h3>AT A GLANCE</h3>
        <table className="plain">
          <tbody>
            <tr><td className="muted">Game mode</td><td>{String(w.settings.gamemode)}</td></tr>
            <tr><td className="muted">Difficulty</td><td>{String(w.settings.difficulty)}{w.settings.hardcore ? ' · hardcore' : ''}</td></tr>
            <tr><td className="muted">World type</td><td>{String(w.settings['level-type']).replace('minecraft:', '')}</td></tr>
            <tr><td className="muted">Seed</td><td className="mono">{String(w.settings['level-seed'] || 'random')}</td></tr>
            <tr><td className="muted">Mods</td><td>{w.mods.length} installed</td></tr>
            <tr><td className="muted">Resource pack</td><td>{w.resourcePack ? w.resourcePack.name : 'none'}</td></tr>
            <tr><td className="muted">Played</td><td>{Math.round(w.playMinutes / 60)} hours · last on {w.lastPlayedVersion ?? 'never'}</td></tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>WHAT PLAYERS NEED</h2>
        {clientMods.length === 0 ? (
          <div className="notice go">
            <p><strong>Nothing to install!</strong> Every mod on this world runs on the server only. Friends join with a normal game, version {s?.server.mcVersion}.</p>
          </div>
        ) : (
          <>
            <div className="notice warn">
              <p>These mods must <strong>also</strong> be installed on each player&apos;s game, or they can&apos;t join. See <Link href="/guides#client-mods">Guides → Installing mods on your game</Link>.</p>
            </div>
            <ul className="rows">
              {clientMods.map((m) => (
                <li key={m.slug}>
                  <span className="grow"><strong>{m.title}</strong> <span className="muted small">{m.versionNumber}</span></span>
                  <a className="btn sm cool" href={`https://modrinth.com/mod/${m.slug}`} target="_blank" rel="noopener noreferrer">GET IT ↗</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <hr />
        <h3>HOW TO JOIN</h3>
        <ol className="steps">
          <li>Open Minecraft <strong>Java Edition {s?.server.mcVersion}</strong>. Fabric is only needed if the list above isn&apos;t empty.</li>
          <li>Multiplayer → Add Server → address <kbd>{s?.server.address}</kbd></li>
          <li>First time: type <kbd>/register yourpassword yourpassword</kbd>. After that: <kbd>/login yourpassword</kbd>. Use a password you don&apos;t use anywhere else.</li>
        </ol>
        {w.resourcePack && <p className="small muted">This world has a resource pack. Your game asks to download it when you join; say yes.</p>}
      </section>
    </div>
  );
}

// Stable callback without re-creating the watcher each render.
function useCallbackOnce(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(() => ref.current(), []);
}
