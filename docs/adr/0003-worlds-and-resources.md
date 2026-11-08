# ADR 0003: Many worlds, one running at a time

- **Status:** accepted

## Context

Friends want to create their own worlds, as on Aternos. The permanent VM is an Oracle Always
Free Arm instance with 1 OCPU and 6 GB (2 and 12 at most), which is enough for one modded
server, not several.

## Decision

- **One server process and one active world.**
  - The active world always lives at `/srv/minecraft/server/world`, and its mods at
    `/srv/minecraft/server/mods`, so `mc-backup`, the backup timer and the systemd unit work
    unchanged.
  - Inactive worlds live in `/srv/minecraft/worlds/<id>/{world,mods}`.
- **Switching** (`activate`) is a background job:
  1. Warn players in game and wait 30 s if anyone is online.
  2. Stop the service.
  3. Rename the current world and mods directories out and the new ones in. Renames on the
     same disk are instant.
  4. Write that world's `server.properties`.
  5. Start the service.
- **The marker file** `server/.hopon-active` records which world is in place, so the agent can
  recover after a crash.
- **Host = creator.** The world's host, plus the owner, handles its sensitive actions (reset,
  delete, restore). Hosts and admins change its settings, mods and pack.
- **Fair use:**
  - The status shows who started the current session and since when.
  - A **queue** ("who's next") lets friends ask for a turn.
  - Switching while players are online is allowed only for the active world's host, admins
    and the owner. Everyone else joins the queue.
- **Quotas:** members can have 3 worlds, admins 5, and the owner has no limit. The total is 12
  worlds. A new world needs 2 GB of free disk.
- **One Minecraft version for the whole server.**
  - Worlds remember the newest version they were played on.
  - A world newer than the server is refused (no downgrade).
  - Upgrading the server is owner-only. It backs up every world first.
- **Shared across worlds:** the whitelist, the ops list and EasyAuth's account database.
  Players register once.
- **Deleted worlds** go to `/srv/minecraft/trash/` and are not wiped. Clearing trash is a
  manual SSH task, on purpose.

## Consequences

- Only one group plays at a time. The UI says so plainly ("1 world can run at a time on our
  free server").
- A switch takes about 30 to 90 s (stop, swap, start) and is shown as a progress job.
