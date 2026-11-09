'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/client/api';

// ---------------------------------------------------------------- toasts
type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Toasts({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run an action with a busy state and a toast on success/failure. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, okText?: string | ((r: T) => string)) => {
      setBusy(label);
      try {
        const r = await fn();
        if (okText) toast('ok', typeof okText === 'function' ? okText(r) : okText);
        return r;
      } catch (e: any) {
        toast('err', e.message || 'Something went wrong');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------- dialogs
/** Dialogs render into <body>: a .panel's clip-path would otherwise clip a dialog opened inside it. */
function DialogShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="modal-back" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="panel raised modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- confirm by typing
export function TypeToConfirm({ word, action, danger = true, onConfirm, onClose, children }: {
  word: string; action: string; danger?: boolean; onConfirm: (typed: string) => void; onClose: () => void; children?: React.ReactNode;
}) {
  const [typed, setTyped] = useState('');
  return (
    <DialogShell onClose={onClose}>
      <h2>{action}</h2>
      {children}
      <label className="field">
        <span>
          Type <strong style={{ color: 'var(--gold)' }}>{word}</strong> to confirm
        </span>
        <input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <div className="btn-row">
        <button className={`btn ${danger ? 'danger' : 'warn'}`} disabled={typed.trim() !== word} onClick={() => onConfirm(typed.trim())}>
          {action}
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <DialogShell onClose={onClose}>
      <div className="panel-head">
        <h2>{title}</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {children}
    </DialogShell>
  );
}

export function TitleTag({ title, tier }: { title?: string | null; tier?: string | null }) {
  if (!title) return null;
  return <span className={`title-tag ${tier || 'common'}`}>{title}</span>;
}

export function CopyButton({ text, label = 'COPY' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'COPIED!' : label}
    </button>
  );
}

/** Follow the agent's background job until it finishes, then call back. */
export function useJobWatcher(onDone?: (job: any) => void) {
  const toast = useToast();
  const [watching, setWatching] = useState<string | null>(null);
  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await api('GET', 'status');
        if (!s.job || s.job.id !== watching) {
          if (s.lastJob?.id === watching) {
            toast(s.lastJob.ok ? 'ok' : 'err', s.lastJob.ok ? `Done: ${s.lastJob.label}` : `Failed: ${s.lastJob.error}`);
            onDone?.(s.lastJob);
          }
          setWatching(null);
          return;
        }
      } catch {
        /* keep trying */
      }
      setTimeout(tick, 1200);
    };
    tick();
    return () => void (stop = true);
  }, [watching, toast, onDone]);
  return { watch: setWatching, watching };
}
