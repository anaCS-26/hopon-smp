// The layout sends people here when the agent rejects their session. Clear the cookie only
// if the agent really rejects it, so another site can't log you out with a link.
import { NextRequest, NextResponse } from 'next/server';
import { readSession, actorFor, sessionCookieName } from '@/lib/server/session';
import { agentFetch } from '@/lib/server/agent';
import { publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const base = publicBase(req);
  const s = await readSession();
  if (!s) return NextResponse.redirect(new URL('/login', base), 303);
  const r = await agentFetch<{ error?: string }>('GET', '/v1/me', { actor: actorFor(s) });
  if (r.status !== 401 && r.status !== 403) return NextResponse.redirect(new URL('/', base), 303);
  const res = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(r.body?.error || 'Please log in again')}`, base), 303);
  res.cookies.delete(sessionCookieName());
  return res;
}
