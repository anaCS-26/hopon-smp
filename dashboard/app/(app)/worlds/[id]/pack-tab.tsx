'use client';
import { useRef, useState } from 'react';
import { api, bytes, timeAgo } from '@/lib/client/api';
import { useAction, useToast } from '@/components/ui';
import type { World } from '../types';

const MAX = 100 * 1024 * 1024;

export function PackTab({ w, canManage, reload }: { w: World; canManage: boolean; reload: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();

  const upload = async () => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) return toast('err', 'Resource packs are .zip files');
    if (file.size > MAX) return toast('err', 'That pack is over 100 MB, too big for our server');
    const ticket = await api<{ uploadUrl: string }>('POST', `worlds/${w.id}/pack-ticket`);
    // Upload straight to the server (Vercel can't carry big files), with a one-time ticket.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', ticket.uploadUrl);
      xhr.setRequestHeader('content-type', 'application/zip');
      xhr.setRequestHeader('x-file-name', file.name.replace(/[^A-Za-z0-9 ._()-]/g, '').slice(0, 64));
      xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        setProgress(null);
        if (xhr.status === 200) resolve();
        else {
          let msg = `upload failed (${xhr.status})`;
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => {
        setProgress(null);
        reject(new Error('could not reach the server to upload'));
      };
      xhr.send(file);
    });
    setFile(null);
    if (fileRef.current) fileRef.current.value = '';
    reload();
  };

  return (
    <div className="grid two">
      <section className="panel">
        <h2>THIS WORLD&apos;S PACK</h2>
        {w.resourcePack ? (
          <>
            <div className="notice go">
              <p>
                <strong>{w.resourcePack.name}</strong> · {bytes(w.resourcePack.size)} · {w.resourcePack.files} files · uploaded {timeAgo(w.resourcePack.at)}
              </p>
            </div>
            <p className="small muted">
              Players are offered this pack when they join. Fingerprint (sha1): <span className="mono" style={{ wordBreak: 'break-all' }}>{w.resourcePack.sha1}</span>
            </p>
            {canManage && (
              <button className="btn danger sm" disabled={!!busy} onClick={() => run('rm', async () => { await api('DELETE', `worlds/${w.id}/pack`); reload(); }, 'Pack removed')}>
                REMOVE PACK
              </button>
            )}
          </>
        ) : (
          <div className="empty"><span className="big">NO PACK</span>Players see the normal textures.</div>
        )}

        {canManage && (
          <>
            <hr />
            <h3>UPLOAD A PACK</h3>
            <input ref={fileRef} type="file" accept=".zip,application/zip" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && <p className="small muted">{file.name} · {bytes(file.size)}</p>}
            {progress !== null && <div className="bar" style={{ margin: '10px 0' }}><i style={{ width: `${progress}%` }} /></div>}
            <button className="btn go" style={{ marginTop: 12 }} disabled={!file || !!busy || progress !== null} onClick={() => run('upload', upload, 'Pack checked and uploaded. Restart the server to apply.')}>
              CHECK &amp; UPLOAD
            </button>
            <p className="small muted">Max 100 MB. The server checks the zip before accepting it (no hidden files, no zip bombs, must contain <kbd>pack.mcmeta</kbd>).</p>
          </>
        )}
        {!canManage && <p className="small muted">Only this world&apos;s host or an admin can change the pack.</p>}
      </section>

      <section className="panel">
        <h2>PACKS, STEP BY STEP</h2>
        <ol className="steps">
          <li>
            Find a pack on a trusted site:{' '}
            <a href="https://modrinth.com/resourcepacks" target="_blank" rel="noopener noreferrer">Modrinth resource packs ↗</a> or{' '}
            <a href="https://www.curseforge.com/minecraft/texture-packs" target="_blank" rel="noopener noreferrer">CurseForge ↗</a>. Pick one that lists Minecraft version <strong>{w.lastPlayedVersion || w.createdVersion}</strong>.
          </li>
          <li>Download the <kbd>.zip</kbd>. Don&apos;t unzip it. (Skip sites that make you click through ads or download an .exe.)</li>
          <li>Upload it here. The world&apos;s players get asked to download it when they join.</li>
          <li>Restart the server from Base Camp so it starts offering the pack.</li>
        </ol>
        <div className="notice">
          <p>Made your own pack? Zip the <em>files inside</em> your pack folder (so <kbd>pack.mcmeta</kbd> sits at the top of the zip), not the folder itself.</p>
        </div>
        <p className="small muted">Want a pack only for yourself? Put the .zip in your game&apos;s <kbd>resourcepacks</kbd> folder instead (Options → Resource Packs → Open Pack Folder).</p>
      </section>
    </div>
  );
}
