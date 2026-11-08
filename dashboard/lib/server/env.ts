// Server-side configuration. Never import this from a client component.
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.startsWith('REPLACE_')) throw new Error(`Missing environment variable ${name} (see dashboard/.env.example)`);
  return v;
}

function key(name: string): Buffer {
  const buf = Buffer.from(required(name), 'base64');
  if (buf.length < 32) throw new Error(`${name} must be at least 32 random bytes (base64)`);
  return buf;
}

export const env = {
  get agentUrl() {
    return required('AGENT_URL').replace(/\/$/, '');
  },
  get agentKeyId() {
    return process.env.AGENT_KEY_ID || 'k1';
  },
  get agentKey() {
    return key('AGENT_HMAC_KEY');
  },
  get sessionSecret() {
    return key('SESSION_SECRET');
  },
  get discord() {
    return {
      clientId: required('DISCORD_CLIENT_ID'),
      clientSecret: required('DISCORD_CLIENT_SECRET'),
      redirectUri: required('DISCORD_REDIRECT_URI'),
    };
  },
  get discordConfigured() {
    return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI);
  },
  /** Mock-user login: only in `next dev`, only when asked for, never on Vercel. */
  get devLogin() {
    return process.env.NODE_ENV === 'development' && process.env.HOPON_DEV_LOGIN === '1' && !process.env.VERCEL;
  },
  get secureCookies() {
    return process.env.NODE_ENV === 'production';
  },
};
