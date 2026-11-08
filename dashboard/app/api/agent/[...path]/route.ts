// Browser -> agent proxy. Checks the session and CSRF, maps the path through a fixed
// allowlist, signs the request and forwards it. Never forwards cookies or raw headers.
import { NextRequest, NextResponse } from 'next/server';
import { readSession, actorFor, sessionCookieName } from '@/lib/server/session';
import { agentFetch } from '@/lib/server/agent';
import { toAgentPath, csrfOk } from '@/lib/server/allowlist.mjs';

export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: 'please log in' }, { status: 401 });

  const ok = csrfOk({
    method: req.method,
    origin: req.headers.get('origin'),
    host: req.headers.get('host'),
    csrfHeader: req.headers.get('x-csrf-token'),
    sessionCsrf: session.c,
    expectedOrigin: process.env.DASHBOARD_ORIGIN || undefined,
  });
  if (!ok) return NextResponse.json({ error: 'security check failed; reload the page' }, { status: 403 });

  const { path } = await ctx.params;
  const agentPath = toAgentPath(req.method, path, req.nextUrl.searchParams);
  if (!agentPath) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const text = await req.text();
    if (text.length > 64 * 1024) return NextResponse.json({ error: 'request too large' }, { status: 413 });
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: 'bad JSON' }, { status: 400 });
      }
    }
  }

  const r = await agentFetch(req.method, agentPath, { actor: actorFor(session), body });
  const res = NextResponse.json(r.body ?? {}, { status: r.status, headers: { 'cache-control': 'no-store' } });
  // The agent says this session is no longer valid (logged out everywhere, or access removed).
  if (r.status === 401) res.cookies.delete(sessionCookieName());
  return res;
}

export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
