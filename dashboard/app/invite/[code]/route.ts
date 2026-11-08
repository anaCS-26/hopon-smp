// Invite links look like /invite/<code>. Remember the code for the login that follows.
import { NextRequest, NextResponse } from 'next/server';
import { seal, cookieOptions, inviteCookieName } from '@/lib/server/session';
import { publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const base = publicBase(req);
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(code)) return NextResponse.redirect(new URL('/login?error=That+invite+link+looks+broken', base), 303);
  const res = NextResponse.redirect(new URL('/login?invited=1', base), 303);
  res.cookies.set(inviteCookieName(), seal({ code }), cookieOptions(3600));
  return res;
}
