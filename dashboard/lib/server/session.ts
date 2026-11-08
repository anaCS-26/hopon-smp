// Signed session cookie. Holds no secrets: the agent's user id, the user's session epoch
// (bumped by "log out everywhere"), a CSRF token and an expiry. Signed with SESSION_SECRET.
import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from './env';

export type Session = { u: string; e: number; c: string; x: number };

const TTL_SECONDS = 14 * 24 * 3600;
export const sessionCookieName = () => (env.secureCookies ? '__Host-hop_session' : 'hop_session');
export const oauthCookieName = () => (env.secureCookies ? '__Host-hop_oauth' : 'hop_oauth');
export const inviteCookieName = () => (env.secureCookies ? '__Host-hop_invite' : 'hop_invite');

function mac(data: string) {
  return crypto.createHmac('sha256', env.sessionSecret).update(data).digest('base64url');
}

export function seal(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${mac(data)}`;
}

export function unseal<T>(value: string | undefined): T | null {
  if (!value || value.length > 2048) return null;
  const [data, sig] = value.split('.');
  if (!data || !sig) return null;
  const expected = Buffer.from(mac(data));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: env.secureCookies, sameSite: 'lax' as const, path: '/', maxAge };
}

export function newSession(userId: string, epoch: number): Session {
  return { u: userId, e: epoch, c: crypto.randomBytes(24).toString('base64url'), x: Math.floor(Date.now() / 1000) + TTL_SECONDS };
}

export function sessionCookie(s: Session) {
  return { name: sessionCookieName(), value: seal(s), ...cookieOptions(TTL_SECONDS) };
}

export async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  const s = unseal<Session>(jar.get(sessionCookieName())?.value);
  if (!s || typeof s.u !== 'string' || !/^[a-z0-9]{6,32}$/.test(s.u) || !Number.isInteger(s.e) || s.x < Date.now() / 1000) return null;
  return s;
}

export function actorFor(s: Session) {
  return `user:${s.u}:${s.e}`;
}
