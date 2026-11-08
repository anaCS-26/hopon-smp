// Local development only: log in as one of the mock agent's fake Discord users.
// Disabled unless NODE_ENV=development, HOPON_DEV_LOGIN=1 and not on Vercel.
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/server/env';
import { finishLogin, publicBase } from '@/lib/server/login';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!env.devLogin) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const base = publicBase(req);
  const origin = req.headers.get('origin');
  if (!origin || new URL(origin).host !== new URL(base).host) return NextResponse.json({ error: 'bad origin' }, { status: 403 });
  const form = await req.formData();
  const discordId = String(form.get('discordId') || '');
  const name = String(form.get('name') || 'dev user');
  if (!/^\d{5,25}$/.test(discordId)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  return finishLogin(base, { discordId, discordName: name, avatarUrl: null, inviteCode: String(form.get('invite') || '') || null });
}
