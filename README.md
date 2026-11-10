# Minecraft on Oracle Cloud Always Free

A self-hosted Minecraft Java server for a small group of friends, plus a Minecraft-themed web
dashboard to run it without SSH. Think "my own Aternos, on my own VM".

> **Status (November 2026):** the server is live and friends play on it. Backups run locally
> every 6 hours and go off-site, encrypted, once a day. The dashboard and its VM agent are
> built and tested; the agent runs on the VM and the Vercel deployment is the next step. The
> server currently sits on a temporary trial-credit VM while Oracle's free Arm capacity is
> unavailable; see [Roadmap](#roadmap).

## Goals

- **Always on, always free.** One `VM.Standard.A1.Flex` (2 OCPU, 12 GB), the full Always Free Arm
  allowance, on a free (non Pay-As-You-Go) account. No surprise bills.
- **Keep the world safe.** Automated backups, with encrypted copies stored off Oracle.
- **No client mods for players.** Everything that matters runs server-side.
- **Secure by default.** Only the Minecraft port is public. The dashboard reaches the VM through
  one signed, allowlisted API. Cloud automation uses a narrowly scoped key.

## Architecture

```
Players ──TCP 25565──────────────────────────▶ ┌──────────────── VM (Ubuntu) ────────────────┐
                                               │ minecraft.service   Fabric, own user, sandbox │
Crew ─▶ Dashboard (Vercel) ──HTTPS + HMAC──▶   │ mc-agent            127.0.0.1 only, allowlist  │
        Discord login        Tailscale Funnel  │ minecraft-backup    every 6 h, local           │
                                               │ minecraft-offsite   daily ─▶ Google Drive      │
Admin ──SSH 22 (one IP)──────────────────────▶ │ mc-alert@           failures ─▶ Discord        │
                                               └────────────────────────────────────────────────┘
```

- **Network:** one VCN and one public subnet with a single security list: TCP 22 from one admin
  IP and TCP 25565 from anywhere. The VCN's default list (SSH from anywhere) is left unattached.
- **Cloud access:** a dedicated IAM user (API key only) whose policy can manage instances,
  networking and volumes inside one compartment, and nothing else.
- **Separate users on the VM:** the game (`minecraft`), the dashboard agent (`mcagent`) and the
  off-site uploader (`mc-offsite`) each run as their own locked-down user in a systemd sandbox.
  A bad mod cannot read the Drive login, the backup passphrase or the dashboard's signing key.
- **Dashboard path:** the browser talks only to the Vercel app; the app signs each request and
  the agent checks the signature, the user's role and an allowlist before doing anything. There
  is no shell access and no extra open port. See
  [ADR 0001](docs/adr/0001-dashboard-security-model.md).

## Repository layout

```
infra/
  oci/provision.ps1       Create or update the network and VM (idempotent, has a dry-run mode)
  deploy.ps1              Push server/ and agent/ to the VM and run health checks
server/
  setup-minecraft.sh      First install: Java, firewall, user, server jar, mods, units
  install-helpers.sh      Update the helper commands and units on a live server (no restart)
  install-offsite.sh      The off-site backup job
  bin/                    mc-cmd, mc-console, mc-backup, mc-allow, mc-offsite, mc-alert
  systemd/                Units and timers
  test/                   Tests for the backup scripts (run in CI)
agent/                    mc-agent: the VM's allowlisted control API (zero dependencies), tests
dashboard/                The Hop On SMP web dashboard (Next.js, for Vercel)
docs/                     Architecture decisions, deploy runbook, off-site backup guide
.github/workflows/ci.yml  Agent tests, dashboard build, script checks
```

## Backups

| Layer | When | Kept | Where |
|---|---|---|---|
| Local (`mc-backup auto`) | every 6 h, skipped while nobody has played | the newest 6, then one a day for 10 days | `/srv/minecraft/backups` |
| Safety copies (before reset, delete, restore, mod removal) | on the action | 30 days | same |
| Manual and `pre-*` backups | on request | forever | same |
| Off-site (`mc-offsite`) | daily | the newest 7, encrypted | Google Drive |

A running server is backed up consistently: autosave is paused, the world is flushed, and the
save is confirmed in the log before archiving. Trashed worlds are emptied after 14 days.
Setup, restore and the restore drill: [docs/offsite-backups.md](docs/offsite-backups.md).

## Alerts

When the server crashes, a backup fails or the off-site upload fails, systemd posts a short
message to the crew's Discord channel (at most one per problem every 30 minutes). Put a channel
webhook URL in `/etc/mc-agent/discord-webhook` (root, 0600) and test it with
`sudo systemctl start mc-alert@test.service`. An empty file means alerts are off.

## Dashboard

A control panel for the crew: start/stop, worlds with hosts, a Modrinth mod shop, resource
packs, backups, a safe console, fun titles and step-by-step guides.

- Run it locally with a pretend server: [dashboard/README.md](dashboard/README.md#run-locally-no-vm-no-discord)
- Install the agent on the VM: [agent/README.md](agent/README.md#install-on-the-vm)
- Go live: [docs/dashboard-deploy-runbook.md](docs/dashboard-deploy-runbook.md)

## Provisioning

Requirements: PowerShell 7.2+, the [OCI CLI](https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm)
configured with a scoped API key, and an SSH key pair.

```powershell
Copy-Item infra/oci/settings.example.json infra/oci/settings.json   # then fill it in
./infra/oci/provision.ps1 -DryRun    # report only
./infra/oci/provision.ps1            # create or update
```

Free-tier guardrails built into the script:

- refuses any shape above 2 OCPU / 12 GB
- refuses to create a second A1 instance (the allowance is account-wide)
- retries "Out of host capacity" every 60 s, and re-checks for an existing VM before every attempt
- re-running it updates the SSH allow-list, for example when your home IP changes

Resource IDs and the VM's public IP are written to `infra/oci/state.json`, which is git-ignored.
The server's IP is never committed.

## Updating a live server

```powershell
./infra/deploy.ps1 -Target temp              # copy, install, health-check
./infra/deploy.ps1 -Target temp -CheckOnly   # health checks only
```

It never restarts the Minecraft server, and it stops with an error if the game's start time
changed while it ran. Changes to `minecraft.service` itself apply at the next restart.

## Tests

```bash
cd agent && npm test                                   # policy, HMAC, workflows against a mock VM
cd dashboard && npm ci && npm run typecheck && npm test && npm run build
bash server/test/mc-backup.test.sh && bash server/test/mc-offsite.test.sh   # Linux or WSL
```

## Roadmap

1. ~~Scoped Oracle access and provisioning~~
2. ~~Server install and hardening (Java 25, Fabric, EasyAuth, firewall, systemd)~~
3. ~~Migrate the world from Aternos~~
4. ~~Backups: local every 6 hours, encrypted off-site daily, restore drill~~
5. Failure alerts to Discord (built; needs a webhook URL on the VM)
6. Move from the temporary VM to the Always Free Arm VM when capacity appears
7. Dashboard go-live on Vercel ([runbook](docs/dashboard-deploy-runbook.md))
8. Tailscale for admin SSH; close public port 22
9. Maybe: an MCP server so an AI assistant can drive the same dashboard API
