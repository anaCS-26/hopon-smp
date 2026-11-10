'use client';
// Browser-side helpers: every call goes to our own /api/agent proxy with the CSRF token.
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function csrf() {
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agent/${path.replace(/^\//, '')}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf() } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 401) {
    window.location.href = '/login?error=' + encodeURIComponent(data?.error || 'Please log in again');
    throw new ApiError(401, 'logged out');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `request failed (${res.status})`);
  return data as T;
}

// ---------------------------------------------------------------- shared GET cache
// The last answer for each GET path, shared by every page in this tab. Coming back to a page
// shows what it showed last time straight away and refreshes in the background, instead of a
// blank "Loading…" while the request goes to Vercel and on to the VM. Logging out reloads the
// page, which empties it.
type Cached = { seq: number; json: string; data: unknown };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_MAX = 40;
let seq = 0;

/** Store a response. Returns the object to render: the previous one if nothing changed (so React
 *  can skip the re-render), or the newer one if a slower, older request finished last. */
function remember(path: string, n: number, data: unknown) {
  const old = cache.get(path);
  if (old && old.seq > n) return old.data;
  const json = JSON.stringify(data);
  if (old && old.json === json) {
    old.seq = n;
    return old.data;
  }
  cache.delete(path); // re-insert so the Map's order is least recently updated first
  cache.set(path, { seq: n, json, data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return data;
}

/** GET through the cache. Polls of the same path share one request; `fresh` (used right after an
 *  action) always starts a new one, so it can't be answered by a request sent before the action. */
function getShared<T>(path: string, fresh: boolean): Promise<T> {
  const running = inflight.get(path);
  if (running && !fresh) return running as Promise<T>;
  const n = ++seq;
  const p = api<T>('GET', path)
    .then((d) => remember(path, n, d) as T)
    .finally(() => {
      if (inflight.get(path) === p) inflight.delete(path);
    });
  inflight.set(path, p);
  return p;
}

/**
 * Fetch (and optionally poll) an agent GET route.
 * `interval` is milliseconds, or a function of the latest data that returns milliseconds, so a
 * page can poll quickly while something is happening and slowly when nothing is. 0 = no polling.
 * Polling pauses while the tab is hidden and catches up the moment it is shown again.
 * A poll that returns exactly what is already on screen does not re-render the page.
 */
export function useAgent<T = any>(path: string | null, interval: number | ((data: T | null) => number) = 0) {
  const [data, setData] = useState<T | null>(() => ((path && cache.get(path)?.data) as T) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(path && cache.has(path)));
  const alive = useRef(true);
  const latest = useRef<T | null>(data);
  const pace = useRef(interval);
  pace.current = interval;
  const reschedule = useRef<() => void>(() => {});

  const fetchData = useCallback(async (fresh: boolean) => {
    if (!path) return;
    try {
      const d = await getShared<T>(path, fresh);
      if (alive.current) {
        latest.current = d;
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    const hit = path ? cache.get(path) : undefined;
    latest.current = (hit?.data as T) ?? null;
    if (hit) {
      setData(hit.data as T);
      setLoading(false);
    }
    const load = () => fetchData(false);
    let active = true; // this run of the effect only; a stale run must never schedule again
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = () => (typeof pace.current === 'function' ? pace.current(latest.current) : pace.current);
    const schedule = () => {
      clearTimeout(timer);
      const ms = wait();
      if (active && ms > 0) timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      clearTimeout(timer);
      if (active && document.visibilityState === 'visible') await load();
      schedule();
    };
    const onVisible = () => {
      if (active && document.visibilityState === 'visible' && wait() > 0) tick();
    };
    reschedule.current = schedule;
    load().then(schedule);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      reschedule.current = () => {};
    };
  }, [path, fetchData]);

  /** Refresh now (e.g. right after an action), then pick the pace again from the new data. */
  const reload = useCallback(async () => {
    await fetchData(true);
    reschedule.current();
  }, [fetchData]);

  return { data, error, loading, reload, setData };
}

/**
 * Pace for the /status route: quick while a job runs or the server is changing state, relaxed
 * otherwise. Every poll is a Vercel function call plus a round trip to the VM, so an idle tab
 * should not ask every few seconds.
 */
export function statusPace(s: { job: unknown; server: { state: string } } | null) {
  if (!s) return 3000;
  return s.job || s.server.state === 'starting' || s.server.state === 'stopping' ? 2500 : 15000;
}

export function timeAgo(iso?: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function duration(fromIso?: string | null) {
  if (!fromIso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function bytes(n?: number | null) {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
