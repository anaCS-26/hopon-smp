import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readSession, actorFor } from '@/lib/server/session';
import { agentFetch } from '@/lib/server/agent';
import { CrewLogo, Avatar } from '@/components/pixel';
import { MeProvider, NavLinks, type Me } from '@/components/me';
import { Toasts, TitleTag } from '@/components/ui';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect('/login');

  const r = await agentFetch<Me & { error?: string }>('GET', '/v1/me', { actor: actorFor(session) });
  if (r.status === 401 || r.status === 403) redirect('/api/auth/expired');
  if (r.status !== 200) {
    return (
      <main className="shell" style={{ maxWidth: 620, paddingTop: '12vh' }}>
        <div className="panel" style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <CrewLogo size={110} />
          </div>
          <h1 className="page-title">AGENT OFFLINE</h1>
          <p className="page-sub" style={{ margin: '0 auto 18px' }}>
            The dashboard can&apos;t reach the server&apos;s control agent right now. The VM may be restarting or moving.
            Players can still try joining; check again in a minute.
          </p>
          <p className="muted small">{r.body?.error}</p>
          <a className="btn" href="/">
            Try again
          </a>
        </div>
      </main>
    );
  }
  const me = r.body;

  return (
    <MeProvider me={me}>
      <Toasts>
        <meta name="csrf-token" content={session.c} />
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand" aria-label="Hop On SMP home">
              <CrewLogo size={58} />
              <span>
                <span className="brand-name">
                  HOP <b>ON</b>
                </span>
                <span className="brand-sub">SMP CONTROL PANEL</span>
              </span>
            </Link>
            <NavLinks showAudit={me.can.audit} />
            <div className="me-chip">
              <Avatar name={me.user.mcName || me.user.name} url={me.user.avatarUrl} size={34} />
              <span className="who">
                <strong>{me.user.name}</strong>
                <TitleTag title={me.user.title} tier={me.user.titleTier} />
              </span>
              <form method="post" action="/api/auth/logout">
                <button className="btn ghost sm" title="Log out">
                  BYE
                </button>
              </form>
            </div>
          </header>
          {children}
        </div>
      </Toasts>
    </MeProvider>
  );
}
