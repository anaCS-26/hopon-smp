import { NextRequest, NextResponse } from 'next/server';
import { sessionCookieName } from '@/lib/server/session';
import { publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

// POST only (a form button), and same-origin only, so other sites can't log you out.
export async function POST(req: NextRequest) {
  const base = publicBase(req);
  const origin = req.headers.get('origin');
  if (!origin || new URL(origin).host !== new URL(base).host) return NextResponse.json({ error: 'bad origin' }, { status: 403 });
  const res = NextResponse.redirect(new URL('/login?bye=1', base), 303);
  res.cookies.delete(sessionCookieName());
  return res;
}
