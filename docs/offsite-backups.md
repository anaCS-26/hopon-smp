# Off-site backups

The VM already makes a local backup every 6 hours (`mc-backup`). Those sit on the same disk as
the world, so they do not survive losing the VM. `mc-offsite` fixes that: once a day it copies
the newest local backup to Google Drive, encrypted.

- **Encrypted on the VM, before upload.** Google stores ciphertext with scrambled file names.
- **Limited Drive access.** The login uses Google's `drive.file` permission: it can only see
  files it created itself, not the rest of your Drive.
- **Kept away from the game.** The Drive login and passphrase live in `/var/lib/mc-offsite`,
  readable only by the `mc-offsite` user. The Minecraft server and its mods run as a different
  user and cannot read them.
- **Retention.** The newest 7 off-site copies are kept (one week). Older ones are deleted for
  good rather than moved to the Drive bin, because the bin counts against your storage.
- **Size.** Each copy is one compressed world, about 1.1 GB in November 2026, so a week is
  about 8 GB of the free 15 GB. Make sure that Google account has the room. To keep more or
  fewer: `sudo systemctl edit minecraft-offsite.service` and add `[Service]` /
  `Environment=KEEP_REMOTE=5`.

## One-time setup (about 10 minutes)

Steps marked **YOU** need the owner. Nothing here stops or restarts the Minecraft server.

### 1. Install the job on the VM

```bash
scp -r server <user>@<vm>:~/
ssh <user>@<vm> 'sudo bash ~/server/install-offsite.sh'
```

### 2. YOU: pick the passphrase

Make a new entry in your password manager called "Minecraft off-site backups" with a generated
passphrase of 16 or more characters. **This is the only copy that survives if the VM is lost.
Without it the backups cannot be read, and nobody can reset it.**

### 3a. YOU: make your own Google "client ID" (10 minutes, free)

rclone ships with a client ID shared by every rclone user in the world. Google throttles it so
hard that large uploads never finish (`RATE_LIMIT_EXCEEDED`), and rclone is retiring it during
2026. Your own one has its own quota. It needs no billing account and no card.

1. Open <https://console.cloud.google.com/> and sign in (any Google account; the one that
   will hold the backups is simplest). Create a project, e.g. `minecraft-backups`.
2. **APIs & Services → Enable APIs and services** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen → Get started**: app name `rclone`, your email as
   support email, audience **External**, your email as contact, agree, **Create**.
4. **Data Access → Add or remove scopes → Manually add scopes**: paste
   `https://www.googleapis.com/auth/drive.file`, **Add to table**, **Update**, **Save**.
5. **Branding**: Google will not publish without a home page link, a privacy policy link and
   an authorized domain. Nobody reviews them for this kind of app; your GitHub profile URL
   for both links and `github.com` as the domain is enough. **Save.**
6. **Audience → Publish app → Confirm.** Do not skip this: an app left in "Testing" logs
   itself out every 7 days and the backups stop. This permission is a non-sensitive one, so
   Google asks for no review.
7. **Clients → Create client** → application type **Desktop app** → **Create**. Copy the
   **Client ID** and **Client secret** into the same password-manager entry as the passphrase.

### 3b. YOU: connect Google Drive

Google's login page has to open in a browser on your laptop, so connect with a tunnel:

```powershell
ssh -L 53682:127.0.0.1:53682 <user>@<vm>
```

In that SSH window:

```bash
sudo mc-offsite setup-drive
```

This opens rclone's setup menu. Answer:

| Question | Answer |
|---|---|
| New remote / name | `n`, then the name `mc-drive` (exactly) |
| Storage | the number next to **Google Drive** |
| client_id, client_secret | paste the two values from step 3a |
| scope | the option described as *"Access to files created by rclone only"* (`drive.file`) |
| service_account_file | empty |
| Edit advanced config | `n` |
| Use web browser to automatically authenticate / auto config | `y` |

rclone prints a link starting with `http://127.0.0.1:53682/auth`. Open it in your laptop's
browser, choose the Google account that should hold the backups, and click **Allow**. Back in
the SSH window:

| Question | Answer |
|---|---|
| Configure this as a Shared Drive | `n` |
| Keep this remote | `y` |
| Then | `q` to quit |

The wording changes a little between rclone versions; the answers do not. Google may show a
"Google hasn't verified this app" page during login: it is your own app, so choose
**Advanced → Go to rclone**.

Already connected with the shared client ID? Run `sudo mc-offsite setup-drive`, choose `e`,
pick `mc-drive`, paste the client ID and secret, keep every other answer, and say `y` to
"Already have a token - refresh?" so you log in again. The passphrase step is not repeated.

### 4. YOU: set the encryption passphrase

```bash
sudo mc-offsite setup-crypt
```

Paste the passphrase from step 2, twice. It is not shown and is not saved in shell history.

### 5. First upload and check

```bash
sudo mc-offsite            # uploads the newest local backup
sudo mc-offsite status     # "Last successful upload ..." and how much is stored
```

In Google Drive you should now see a folder `minecraft-backups` holding one file with a
scrambled name. From here the timer runs it every day at about 06:30 UTC:

```bash
systemctl list-timers minecraft-offsite.timer
journalctl -u minecraft-offsite -n 30
```

## Getting a backup back

On the VM that made the backups:

```bash
sudo mc-offsite list
sudo mc-offsite fetch <name from the list>
sudo install -o minecraft -g minecraft -m 0640 \
  /var/lib/mc-offsite/fetched/<name from the list> /srv/minecraft/backups/
```

The file is then an ordinary local backup: restore it from the dashboard, or by hand with the
server stopped.

On a **new** VM (the old one is gone): run `install-offsite.sh`, repeat steps 3 and 4 with the
**same Google account and the same passphrase**, then `list` and `fetch` as above.

On your own computer: install rclone, create the same two remotes (`mc-drive`, then a `crypt`
remote on `mc-drive:minecraft-backups` with the passphrase), and run
`rclone copy mc-offsite:<file> .`

## Do a restore drill

A backup nobody has restored is a guess. Once after setup, and again after the move to the Arm
VM: `fetch` the newest copy, unpack it into a scratch folder
(`tar -xzf <file> -C /tmp/drill`) and check that `world/level.dat` is there.

## If it stops working

`sudo mc-offsite status` exits with an error when nothing has been uploaded for 48 hours.

| Message | Meaning |
|---|---|
| `not set up yet` | Steps 3 and 4 have not been done on this VM |
| `could not be confirmed` | The upload did not arrive complete. Nothing was pruned. It retries tomorrow, or run `sudo mc-offsite` now |
| `is damaged on disk` | The newest local backup is corrupt. Run `mc-backup`, then `sudo mc-offsite` |
| rclone says the token is invalid or expired | Google revoked the login. Run `sudo mc-offsite setup-drive`, choose `e` to edit `mc-drive`, and log in again. The passphrase and existing backups are unaffected |
