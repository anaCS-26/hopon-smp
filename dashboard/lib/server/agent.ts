// Signed calls to the VM agent. Mirrors agent/src/hmac.mjs (see ADR 0001).
import crypto from 'node:crypto';
import { env } from './env';

export class AgentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type AgentResult<T = unknown> = { status: number; body: T };

export async function agentFetch<T = any>(method: string, path: string, { actor, body }: { actor: string; body?: unknown }): Promise<AgentResult<T>> {
  if (!path.startsWith('/v1/')) throw new Error('agent paths start with /v1/');
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const canonical = ['v1', method.toUpperCase(), path, String(ts), nonce, actor, bodyHash].join('\n');
  const sig = crypto.createHmac('sha256', env.agentKey).update(canonical).digest('base64url');

  let res: Response;
  try {
    res = await fetch(env.agentUrl + path, {
      method,
      headers: {
        'x-hop-kid': env.agentKeyId,
        'x-hop-ts': String(ts),
        'x-hop-nonce': nonce,
        'x-hop-actor': actor,
        'x-hop-sig': sig,
        ...(raw ? { 'content-type': 'application/json' } : {}),
      },
      body: raw || undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 503, body: { error: 'The server control agent is offline. The VM may be restarting.' } as T };
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: 'unexpected reply from the agent' };
  }
  return { status: res.status, body: parsed };
}
