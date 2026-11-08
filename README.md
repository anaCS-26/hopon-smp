# Minecraft on Oracle Cloud Always Free

A self-hosted Minecraft Java server for a small group of friends, running 24/7 on Oracle Cloud's
Always Free Arm VM, plus (eventually) a Minecraft-themed web dashboard to run it without SSH.
Think "my own Aternos, on my own VM".

> **Status:** early. Infrastructure provisioning is in place; server install, world migration,
> backups and the dashboard are next. See [Roadmap](#roadmap).

## Goals

- **Always on, always free.** One `VM.Standard.A1.Flex` (2 OCPU, 12 GB), the full Always Free Arm
  allowance, on a free (non Pay-As-You-Go) account. No surprise bills.
- **Keep the world safe.** Automated backups, with encrypted copies stored off Oracle.
- **No client mods for players.** Everything that matters runs server-side.
- **Secure by default.** Only the Minecraft port is public. Admin access goes through Tailscale.
  Cloud automation uses a narrowly scoped key.

## Architecture (current)

```
Players ──TCP 25565──▶ Oracle VCN (security list) ──▶ mc-server (Ubuntu 26.04, Arm)
Admin   ──SSH 22 (single IP, temporary)──────────────▶        │
                                                              └─ Minecraft (Fabric) as an unprivileged user
```

- **Network:** one VCN and one public subnet. The subnet has only `mc-seclist` attached: TCP 22
  from one admin IP and TCP 25565 from anywhere. The VCN's default security list, which allows SSH
  from anywhere, is deliberately left unattached.
- **Cloud access:** a dedicated IAM user (`claude-automation`, API-key only) in a group whose policy
  can manage only instances, networking and volumes inside the `minecraft` compartment. It cannot
  read or change users, policies, billing or anything outside that compartment.

## Repository layout

```
infra/oci/
  provision.ps1           Create or update the network and VM (idempotent, has a dry-run mode)
  settings.example.json   Template for settings.json (git-ignored: IDs and admin IP)
```

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

## Roadmap

1. ~~Scoped Oracle access and provisioning~~
2. Server install and hardening (Java 25, Fabric 26.3, EasyAuth, firewall, systemd)
3. Migrate the existing world and verify with players
4. Backups: frequent on-VM snapshots, plus daily encrypted off-site copies to Google Drive
5. Tailscale for admin access; close public SSH
6. Dashboard: status, start/stop, console, backups; then worlds, resource packs and roles
7. Maybe: an MCP server so an AI assistant can drive the same dashboard API
