#Requires -Version 7.2
<#
.SYNOPSIS
    Pushes this repo's server helpers and dashboard agent to the Minecraft VM and checks the result.

.DESCRIPTION
    One command instead of scp + ssh + installer + manual checks. Safe to re-run.

    It never stops, starts or restarts the Minecraft server, and it fails loudly if the game
    server's start time changed while it ran. Updating the agent restarts only the dashboard
    agent (a few seconds of "dashboard unavailable"; players are not affected).

    The VM's address is read from infra/oci/state.json or state-temp.json (git-ignored) and is
    never printed.

.PARAMETER Target
    temp = the stop-gap VM (state-temp.json). main = the Always Free Arm VM (state.json).

.PARAMETER What
    helpers = server/ scripts and systemd units (install-helpers.sh).
    agent   = the dashboard agent (install-agent.sh).
    all     = helpers, plus the agent if it is already installed on the VM.

.PARAMETER CheckOnly
    Copy nothing and install nothing; just run the health checks.

.EXAMPLE
    ./infra/deploy.ps1 -Target temp
    ./infra/deploy.ps1 -Target temp -CheckOnly
#>
[CmdletBinding()]
param(
    [ValidateSet('temp', 'main')][string]$Target = 'temp',
    [ValidateSet('helpers', 'agent', 'all')][string]$What = 'all',
    [string]$StateDir = (Join-Path $PSScriptRoot 'oci'),
    [string]$SshKey = (Join-Path $HOME '.ssh/oracle_mc'),
    [string]$User = 'ubuntu',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path $PSScriptRoot -Parent
$stateFile = Join-Path $StateDir ($Target -eq 'temp' ? 'state-temp.json' : 'state.json')
if (-not (Test-Path $stateFile)) { throw "No $stateFile. Has that VM been provisioned from this checkout?" }
$ip = (Get-Content $stateFile -Raw | ConvertFrom-Json).publicIp
if (-not $ip) { throw "No publicIp in $stateFile." }
$dest = "$User@$ip"
$sshArgs = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-i', $SshKey)
# Prefer Windows' own OpenSSH: it talks to the Windows ssh-agent that holds the unlocked key.
# (Git's bundled ssh, which wins on PATH inside Git Bash, cannot.)
$winSsh = if ($env:WINDIR) { Join-Path $env:WINDIR 'System32\OpenSSH' } else { $null }
$Ssh = if ($winSsh -and (Test-Path (Join-Path $winSsh 'ssh.exe'))) { Join-Path $winSsh 'ssh.exe' } else { 'ssh' }
$Scp = if ($winSsh -and (Test-Path (Join-Path $winSsh 'scp.exe'))) { Join-Path $winSsh 'scp.exe' } else { 'scp' }

function Write-Step([string]$Message) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message) }

# Run a bash script on the VM (sent over stdin, LF only). Output has the VM's address removed.
function Invoke-Remote([string]$Script, [switch]$AllowFailure) {
    # PowerShell ends piped text with CRLF. The trailing "#" line soaks up that stray CR as a comment;
    # without it the last command's final argument gets a CR glued on (a folder named "x<CR>").
    $out = (($Script -replace "`r", '') + "`n#") | & $Ssh @sshArgs $dest 'bash -s' 2>&1
    $code = $LASTEXITCODE
    $text = (($out | Out-String) -replace [regex]::Escape($ip), '<vm>').TrimEnd()
    if ($text) { Write-Host $text }
    if ($code -ne 0 -and -not $AllowFailure) { throw "The remote step failed (exit $code)." }
    return $text
}

Write-Step "Target: $Target VM. Checking SSH (the key must be loaded in ssh-agent: ssh-add $SshKey)"
$before = Invoke-Remote @'
set -eu
echo "host: $(hostname)"
echo "minecraft: $(systemctl is-active minecraft || true), running since: $(systemctl show minecraft -p ActiveEnterTimestamp --value)"
'@
$startedBefore = ($before -split "`n" | Where-Object { $_ -match 'running since: (.*)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1

if (-not $CheckOnly) {
    $folders = @()
    if ($What -in 'helpers', 'all') { $folders += 'server' }
    if ($What -in 'agent', 'all') { $folders += 'agent' }

    Write-Step "Copying: $($folders -join ', ')"
    Invoke-Remote 'rm -rf ~/hopon-deploy && mkdir -p ~/hopon-deploy' | Out-Null
    foreach ($f in $folders) {
        $src = Join-Path $repo $f
        if (Test-Path (Join-Path $src 'node_modules')) { throw "$src contains node_modules; remove it before deploying." }
        & $Scp -q @sshArgs -r $src "${dest}:~/hopon-deploy/" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Copying $f failed." }
    }

    # Windows line endings break bash scripts and systemd units; refuse rather than install them.
    Invoke-Remote @'
set -eu
bad="$(grep -rlI "$(printf '\r')" ~/hopon-deploy --include='*.sh' --include='*.service' --include='*.timer' --include='*.socket' --include='*.mjs' --include='mc-*' || true)"
if [ -n "$bad" ]; then echo "Files with Windows line endings (fix .gitattributes / re-checkout):"; echo "$bad"; exit 1; fi
echo "line endings ok"
'@ | Out-Null

    if ('server' -in $folders) {
        Write-Step 'Installing server helpers and units (the game server is not restarted)'
        Invoke-Remote 'set -o pipefail; sudo -n bash ~/hopon-deploy/server/install-helpers.sh 2>&1 | tail -n 12' | Out-Null
    }
    if ('agent' -in $folders) {
        $installAgent = if ($What -eq 'agent') { $true } else {
            (Invoke-Remote 'test -d /opt/mc-agent && echo agent-present || echo agent-absent') -match 'agent-present'
        }
        if ($installAgent) {
            Write-Step 'Updating the dashboard agent (restarts only the agent)'
            Invoke-Remote 'set -o pipefail; sudo -n bash ~/hopon-deploy/agent/install/install-agent.sh 2>&1 | tail -n 12' | Out-Null
        }
        else { Write-Step 'Dashboard agent is not installed on this VM; skipped (use -What agent to install it)' }
    }
}

Write-Step 'Health checks'
$after = Invoke-Remote -AllowFailure @'
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }
echo "minecraft: $(systemctl is-active minecraft), running since: $(systemctl show minecraft -p ActiveEnterTimestamp --value)"
check "minecraft service is active"             'systemctl is-active --quiet minecraft'
check "local backup timer is scheduled"         'systemctl is-active --quiet minecraft-backup.timer'
check "off-site backup timer is scheduled"      'systemctl is-active --quiet minecraft-offsite.timer'
check "no failed minecraft/mc units"            '[ -z "$(systemctl list-units --failed --plain --no-legend "minecraft*" "mc-*")" ]'
check "disk has more than 5 GB free"            '[ "$(df -Pk /srv/minecraft | awk "NR==2{print \$4}")" -gt 5242880 ]'
if [ -d /opt/mc-agent ]; then check "dashboard agent answers /healthz" 'curl -fsS -m 5 http://127.0.0.1:8787/healthz'; fi
if sudo -n test -f /var/lib/mc-offsite/rclone.conf; then
  check "off-site backup uploaded in the last 48 h" 'sudo -n mc-offsite status'
else
  echo "note  off-site backups are not connected to Google Drive yet (docs/offsite-backups.md)"
fi
if sudo -n test -s /etc/mc-agent/discord-webhook; then echo "ok    Discord alerts have a webhook"; else echo "note  Discord alerts are off: no webhook in /etc/mc-agent/discord-webhook"; fi
echo "disk: $(df -h /srv/minecraft | awk 'NR==2{print $3" used, "$4" free"}'); backups: $(sudo -n du -sh /srv/minecraft/backups 2>/dev/null | cut -f1)"
exit $fail
'@
$checksFailed = $LASTEXITCODE -ne 0 -or $after -match '(?m)^FAIL'

$startedAfter = ($after -split "`n" | Where-Object { $_ -match 'running since: (.*)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1
if ($startedBefore -and $startedAfter -and $startedBefore -ne $startedAfter) {
    throw "The Minecraft server's start time changed during the deploy ($startedBefore -> $startedAfter). It was restarted or crashed; check: journalctl -u minecraft -n 50"
}
if ($checksFailed) { throw 'One or more health checks failed (see FAIL lines above).' }
Write-Step 'Done. All checks passed.'
