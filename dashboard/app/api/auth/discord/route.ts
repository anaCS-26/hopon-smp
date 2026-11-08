// Start Discord OAuth2 (authorization code + PKCE + state). Scope "identify" only: no email.
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/server/env';
import { seal, unseal, cookieOptions, oauthCookieName, inviteCookieName } from '@/lib/server/session';
import { publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const base = publicBase(req);
  if (!env.discordConfigured) return NextResponse.redirect(new URL('/login?error=Discord+login+is+not+set+up+yet', base), 303);
  const { clientId, redirectUri } = env.discord;
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const invite = unseal<{ code: string }>(req.cookies.get(inviteCookieName())?.value)?.code ?? null;

  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'identify',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'none',
  }).toString();

  const res = NextResponse.redirect(url, 303);
  res.cookies.set(oauthCookieName(), seal({ s: state, v: verifier, i: invite, x: Date.now() + 10 * 60_000 }), cookieOptions(600));
  return res;
}
