'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAgent } from '@/lib/client/api';
import { useAction } from '@/components/ui';
import { useMe } from '@/components/me';

type LogData = { lines: string[]; help: { usage: string; level: string; about: string }[]; gamerules: string[] };

const QUICK: [string, string, 'basic' | 'host'][] = [
  ['Who is on?', 'list', 'basic'],
  ['Make it day', 'time set day', 'host'],
  ['Make it night', 'time set night', 'host'],
  ['Clear weather', 'weather clear', 'host'],
  ['Keep inventory ON', 'gamerule keepInventory true', 'host'],
  ['Keep inventory OFF', 'gamerule keepInventory false', 'host'],
  ['Save now', 'save-all', 'host'],
];

function lineClass(l: string) {
  if (/\/(WARN)\]/.test(l)) return 'warn';
  if (/\/(ERROR|FATAL)\]/.test(l)) return 'err';
  if (/\[Dashboard\]/.test(l)) return 'dash';
  if (/: <[^>]+> /.test(l) || /\[Server\]/.test(l)) return 'chat';
  return '';
}

const LogLine = memo(function LogLine({ text }: { text: string }) {
  return <div className={lineClass(text)}>{text}</div>;
});

/**
 * A key for each log line that stays with it as the 300-line window slides down the log, so a
 * poll adds the new rows and drops the oldest instead of rewriting all 300 every 2 seconds.
 */
function useLineKeys(lines: string[] | undefined) {
  const prev = useRef<{ lines: string[]; keys: number[]; next: number }>({ lines: [], keys: [], next: 0 });
  return useMemo(() => {
    if (!lines) return [];
    const p = prev.current;
    // How far did the window move? Find where the new lines start in the previous ones.
    let shift = 0;
    for (; shift < p.lines.length; shift++) {
      const n = Math.min(p.lines.length - shift, lines.length);
      let i = 0;
      while (i < n && p.lines[shift + i] === lines[i]) i++;
      if (i === n) break;
    }
    const overlap = Math.min(p.lines.length - shift, lines.length);
    let next = p.next;
    const keys = lines.map((_, i) => (i < overlap ? p.keys[shift + i] : next++));
    prev.current = { lines, keys, next };
    return keys;
  }, [lines]);
}

export default function ConsolePage() {
  const me = useMe();
  const { data, reload } = useAgent<LogData>('server/log?lines=300', 2000);
  const [cmd, setCmd] = useState('');
  const { busy, run } = useAction();
  const keys = useLineKeys(data?.lines);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const canHost = me.can.consoleHost;

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  const send = (line: string) =>
    run('send', async () => {
      const r = await api<{ sent: string }>('POST', 'server/console', { command: line });
      setCmd('');
      setTimeout(reload, 400);
      return r;
    }, (r) => `Sent: ${r.sent}`);

  return (
    <>
      <h1 className="page-title">CONSOLE</h1>
      <p className="page-sub">
        The server&apos;s live log. You can send commands from a safe list. Dangerous ones (like <kbd>op</kbd> or <kbd>stop</kbd>) aren&apos;t available here on purpose.
        {!canHost && ' Most commands are for the host of the running world; you can use list and say.'}
      </p>
      <div className="grid two">
        <section className="panel">
          <div
            className="console"
            ref={box}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            aria-live="off"
          >
            {data?.lines.length ? data.lines.map((l, i) => <LogLine key={keys[i]} text={l} />) : <span className="muted">No log yet. Start the server to see it here.</span>}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (cmd.trim()) send(cmd.trim());
            }}
            style={{ display: 'flex', gap: 10, marginTop: 12 }}
          >
            <span className="mono" style={{ color: 'var(--moss)', alignSelf: 'center' }}>&gt;</span>
            <input className="input mono" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="say hello everyone" maxLength={256} aria-label="Command" autoComplete="off" spellCheck={false} />
            <button className="btn go" disabled={!cmd.trim() || !!busy}>SEND</button>
          </form>
        </section>
        <section className="panel">
          <h2>QUICK BUTTONS</h2>
          <div className="btn-row">
            {QUICK.map(([label, line, level]) => (
              <button key={line} className="btn sm" disabled={!!busy || (level === 'host' && !canHost)} onClick={() => send(line)}>{label}</button>
            ))}
          </div>
          <hr />
          <h3>ALLOWED COMMANDS</h3>
          <table className="plain">
            <tbody>
              {data?.help.map((h) => (
                <tr key={h.usage}>
                  <td className="mono" style={{ fontSize: 18 }}>{h.usage}</td>
                  <td className="small">{h.about} <span className={`badge ${h.level === 'basic' ? 'go' : h.level === 'host' ? 'warn' : 'danger'}`}>{h.level === 'basic' ? 'ANYONE' : h.level === 'host' ? 'HOST' : 'ADMIN'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Player IP addresses and anything typed after /login or /register are hidden from this log.</p>
        </section>
      </div>
    </>
  );
}
