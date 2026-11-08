import { NextResponse } from 'next/server';
import { agentFetch } from './agent';
import { newSession, sessionCookie, inviteCookieName, oauthCookieName } from './session';

/** Ask the agent to log this Discord user in, and set our session cookie on success. */
export async function finishLogin(base: string, who: { discordId: string; discordName: string; avatarUrl: string | null; inviteCode?: string | null }) {
  const r = await agentFetch<{ user?: { id: string }; epoch?: number; error?: string }>('POST', '/v1/auth/login', {
    actor: 'system:login',
    body: { discordId: who.discordId, discordName: who.discordName, avatarUrl: who.avatarUrl, inviteCode: who.inviteCode || undefined },
  });
  if (r.status !== 200 || !r.body.user || typeof r.body.epoch !== 'number') {
    const url = new URL('/login', base);
    url.searchParams.set('error', (r.body?.error || 'login failed').slice(0, 160));
    const res = NextResponse.redirect(url, 303);
    res.cookies.delete(oauthCookieName());
    return res;
  }
  const res = NextResponse.redirect(new URL('/', base), 303);
  const c = sessionCookie(newSession(r.body.user.id, r.body.epoch));
  res.cookies.set(c.name, c.value, c);
  res.cookies.delete(oauthCookieName());
  res.cookies.delete(inviteCookieName());
  return res;
}

export function publicBase(req: Request) {
  // Behind Vercel the host header is trustworthy; locally it is localhost.
  return process.env.DASHBOARD_ORIGIN || new URL(req.url).origin;
}
