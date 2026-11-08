# ADR 0002: Dashboard login with Discord, invite-only

- **Status:** accepted (chosen by the owner, 2026-11-08)

## Context

The server runs `online-mode=false`, so some players have no Microsoft account and Microsoft
login can't be the dashboard's identity. We still need a strong identity with no passwords for
us to store.

## Decision

- **Discord OAuth2** (authorization-code flow with PKCE and `state`). Scope `identify` only, so
  we never see email addresses.
- **Invite-only.**
  - The owner's Discord user ID is set on the VM (`OWNER_DISCORD_ID`). The first login with
    that ID becomes the owner, titled **Team Leader**.
  - Everyone else needs an invite link made by the owner. The code is 128 bits, single use and
    expires after 7 days, and the agent stores only its sha256.
  - Logging in with a Discord account that has no user and no valid invite is refused.
- **The agent stores the user list** (on the VM), not Vercel. So there is no database on
  Vercel, and disabling a user on the VM takes effect at once.
- **Minecraft names** are linked per user. The user requests a name, and the owner or an admin
  approves it; approval runs `mc-allow` (offline UUID).

## Alternatives

- **Passkeys:** no third party, but every friend has to enrol on every device, and recovery
  means re-inviting.
- **Email magic links:** need an email-sending account and another secret.

## Consequences

- The owner creates a Discord application once:
  - Redirect URI `https://<dashboard>/api/auth/callback`.
  - Put the client ID and secret into Vercel env.
- If Discord is down, nobody can log in. Already-logged-in sessions keep working.
