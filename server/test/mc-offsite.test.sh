#!/usr/bin/env bash
# Tests bin/mc-offsite against a stand-in for rclone (test/fakebin/rclone). Run: bash test/mc-offsite.test.sh
set -uo pipefail
HERE0="$(cd "$(dirname "$0")" && pwd)"; SUT="${1:-$HERE0/../bin/mc-offsite}"
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"
chmod +x "$HERE"/fakebin/* 2>/dev/null || true
export PATH="$HERE/fakebin:$PATH"
export MC_BACKUP_DIR="$W/backups" MC_OFFSITE_STATE="$W/state" MC_OFFSITE_USER="$(id -un)" FAKE_REMOTE="$W/remote"
mkdir -p "$MC_BACKUP_DIR" "$MC_OFFSITE_STATE" "$FAKE_REMOTE"
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "ok   - $1"; else fail=$((fail+1)); echo "FAIL - $1"; fi; }
mk() { echo "data $1" | gzip > "$MC_BACKUP_DIR/$1"; touch -d "$2" "$MC_BACKUP_DIR/$1"; }

out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "refuses before setup" '[ $rc -ne 0 ] && [[ "$out" == *"not set up"* ]]'

printf '[mc-drive]\ntype = drive\n\n[mc-offsite]\ntype = drive\n' > "$MC_OFFSITE_STATE/rclone.conf"
out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "refuses a non-crypt destination" '[ $rc -ne 0 ] && [[ "$out" == *"refusing to upload"* ]]'

printf '[mc-drive]\ntype = drive\n\n[mc-offsite]\ntype = crypt\nremote = mc-drive:x\n' > "$MC_OFFSITE_STATE/rclone.conf"
out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "no backups: exits 0, uploads nothing" '[ $rc -eq 0 ] && [ -z "$(ls "$FAKE_REMOTE")" ]'

mk world-20261101-000000Z-auto.tar.gz "2026-11-01"
mk world-20261102-000000Z-hopon_manual.tar.gz "2026-11-02"
out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "uploads only the newest" '[ $rc -eq 0 ] && [ "$(ls "$FAKE_REMOTE")" = world-20261102-000000Z-hopon_manual.tar.gz ]'
ok "records last-success" 'grep -q hopon_manual "$MC_OFFSITE_STATE/last-success"'
out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "re-run is a no-op success" '[ $rc -eq 0 ] && [ "$(ls "$FAKE_REMOTE" | wc -l)" -eq 1 ]'

for d in 03 04 05 06; do mk "world-202611$d-000000Z-auto.tar.gz" "2026-11-$d"; KEEP_REMOTE=3 bash "$SUT" run >/dev/null 2>&1; done
ok "prune keeps the newest 3" '[ "$(ls "$FAKE_REMOTE" | tr "\n" " ")" = "world-20261104-000000Z-auto.tar.gz world-20261105-000000Z-auto.tar.gz world-20261106-000000Z-auto.tar.gz " ]'
echo keep > "$FAKE_REMOTE/notes.txt"
mk world-20261107-000000Z-auto.tar.gz "2026-11-07"; KEEP_REMOTE=1 bash "$SUT" run >/dev/null 2>&1
ok "prune ignores files it did not make" '[ -f "$FAKE_REMOTE/notes.txt" ] && [ "$(ls "$FAKE_REMOTE" | wc -l)" -eq 2 ]'

mk world-20261108-000000Z-auto.tar.gz "2026-11-08"
out="$(FAKE_TRUNCATE=1 KEEP_REMOTE=1 bash "$SUT" run 2>&1)"; rc=$?
ok "short upload: fails, prunes nothing" '[ $rc -ne 0 ] && [[ "$out" == *"could not be confirmed"* ]] && [ -f "$FAKE_REMOTE/world-20261107-000000Z-auto.tar.gz" ]'
ok "short upload: last-success unchanged" 'grep -q 20261107 "$MC_OFFSITE_STATE/last-success"'
rm "$FAKE_REMOTE/world-20261108-000000Z-auto.tar.gz"

echo "not gzip" > "$MC_BACKUP_DIR/world-20261109-000000Z-auto.tar.gz"
out="$(bash "$SUT" run 2>&1)"; rc=$?
ok "damaged local backup is not uploaded" '[ $rc -ne 0 ] && [ ! -f "$FAKE_REMOTE/world-20261109-000000Z-auto.tar.gz" ]'
rm "$MC_BACKUP_DIR/world-20261109-000000Z-auto.tar.gz"

out="$(FAKE_LSF_FAIL=1 bash "$SUT" run 2>&1)"; rc=$?
ok "listing failure: run fails" '[ $rc -ne 0 ]'

out="$(bash "$SUT" list 2>&1)"; rc=$?
ok "list shows backups only" '[ $rc -eq 0 ] && [[ "$out" == *20261107* ]] && [[ "$out" != *notes* ]]'
out="$(bash "$SUT" fetch world-20261107-000000Z-auto.tar.gz 2>&1)"; rc=$?
ok "fetch downloads a readable archive" '[ $rc -eq 0 ] && gzip -t "$MC_OFFSITE_STATE/fetched/world-20261107-000000Z-auto.tar.gz"'
out="$(bash "$SUT" fetch ../../etc/passwd 2>&1)"; rc=$?
ok "fetch rejects odd names" '[ $rc -ne 0 ]'
out="$(bash "$SUT" fetch world-20200101-000000Z-auto.tar.gz 2>&1)"; rc=$?
ok "fetch of a missing file fails" '[ $rc -ne 0 ] && [[ "$out" == *"not off-site"* ]]'

printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" x > "$MC_OFFSITE_STATE/last-success"
out="$(bash "$SUT" status 2>&1)"; rc=$?
ok "status ok when fresh" '[ $rc -eq 0 ] && [[ "$out" == *"2 backup(s)"* ]]'
printf '2026-01-01T00:00:00Z x\n' > "$MC_OFFSITE_STATE/last-success"
out="$(bash "$SUT" status 2>&1)"; rc=$?
ok "status warns when stale" '[ $rc -ne 0 ] && [[ "$out" == *WARNING* ]]'
out="$(KEEP_REMOTE=0 bash "$SUT" run 2>&1)"; rc=$?
ok "KEEP_REMOTE=0 rejected" '[ $rc -ne 0 ]'

rm -rf "$W"
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
