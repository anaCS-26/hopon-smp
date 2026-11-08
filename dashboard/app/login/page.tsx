import { redirect } from 'next/navigation';
import { Frog } from '@/components/pixel';
import { env } from '@/lib/server/env';
import { readSession } from '@/lib/server/session';

const MOCK_USERS = [
  ['100000000000000001', 'Leader', 'Team Leader (owner)'],
  ['100000000000000002', 'Zbeast', 'Redstone Wizard (admin)'],
  ['100000000000000003', 'PixelPanda', 'Cave Explorer (member, hosts Panda Skyblock)'],
  ['100000000000000004', 'MossyMax', 'Dirt Hut Architect (member)'],
  ['100000000000000099', 'Stranger', 'Not invited (should be refused)'],
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (await readSession().catch(() => null)) redirect('/');
  const error = typeof sp.error === 'string' ? sp.error.slice(0, 200) : null;

  return (
    <main className="shell" style={{ maxWidth: 560, paddingTop: '10vh' }}>
      <div className="panel" style={{ textAlign: 'center', padding: '34px 28px 30px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <Frog size={88} />
        </div>
        <h1 className="brand-name" style={{ fontSize: 24, margin: '0 0 6px' }}>
          HOP <b>ON</b>
        </h1>
        <p className="mono" style={{ color: 'var(--ink-3)', margin: '0 0 22px' }}>
          SMP CONTROL PANEL
        </p>

        {sp.invited && !error && (
          <div className="notice go" style={{ textAlign: 'left' }}>
            <p>You have an invite! Log in with Discord to join the crew.</p>
          </div>
        )}
        {sp.bye && <p className="muted">Logged out. See you next session.</p>}
        {error && (
          <div className="notice danger" style={{ textAlign: 'left' }}>
            <p>{error}</p>
          </div>
        )}

        <a className="btn cool big" href="/api/auth/discord" style={{ width: '100%' }}>
          Log in with Discord
        </a>
        <p className="small muted" style={{ marginTop: 16 }}>
          Invite only. We only ask Discord for your user name and picture, never your email.
          <br />
          New here? Ask the Team Leader for an invite link.
        </p>
      </div>

      {env.devLogin && (
        <div className="panel" style={{ marginTop: 22 }}>
          <h2>
            Dev login <span className="hint">mock agent only, never on Vercel</span>
          </h2>
          <ul className="rows">
            {MOCK_USERS.map(([id, name, about]) => (
              <li key={id}>
                <div className="grow">
                  <strong>{name}</strong> <span className="muted small">{about}</span>
                </div>
                <form method="post" action="/api/auth/dev">
                  <input type="hidden" name="discordId" value={id} />
                  <input type="hidden" name="name" value={name} />
                  <button className="btn sm">Log in</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
