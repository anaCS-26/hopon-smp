// Discord redirects here. Verify state, swap the code for a token (with the PKCE verifier),
// read the Discord user id, then let the agent decide whether they are invited.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/server/env';
import { unseal, oauthCookieName } from '@/lib/server/session';
import { finishLogin, publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

type OAuthState = { s: string; v: string; i: string | null; x: number };

function fail(base: string, msg: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, base), 303);
  res.cookies.delete(oauthCookieName());
  return res;
}

export async function GET(req: NextRequest) {
  const base = publicBase(req);
  const st = unseal<OAuthState>(req.cookies.get(oauthCookieName())?.value);
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state') || '';
  if (req.nextUrl.searchParams.get('error')) return fail(base, 'Discord login was cancelled');
  if (!st || st.x < Date.now() || !code || code.length > 200) return fail(base, 'Login expired, please try again');
  const a = Buffer.from(st.s);
  const b = Buffer.from(state);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(base, 'Login check failed, please try again');

  const { clientId, clientSecret, redirectUri } = env.discord;
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: st.v, client_id: clientId, client_secret: clientSecret }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!tokenRes?.ok) return fail(base, 'Discord did not accept the login');
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return fail(base, 'Discord did not accept the login');

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${token.access_token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!meRes?.ok) return fail(base, 'Could not read your Discord profile');
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  if (!/^\d{5,25}$/.test(me.id)) return fail(base, 'Unexpected Discord profile');

  const avatarUrl = me.avatar && /^[a-f0-9_]{1,40}$/.test(me.avatar) ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null;
  return finishLogin(base, { discordId: me.id, discordName: (me.global_name || me.username || 'player').slice(0, 32), avatarUrl, inviteCode: st.i });
}
