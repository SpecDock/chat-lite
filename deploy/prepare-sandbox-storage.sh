#!/bin/sh
set -eu
# MANUAL HOST PREREQUISITE ONLY. NEVER mounts, formats, creates a loop device,
# modifies fstab, or deletes files. Do NOT invoke from deploy/startup.
# Operator must provide a dedicated already-mounted XFS filesystem at
# /var/lib/chat-lite/table-sandbox, with prjquota (not pqnoenforce), on Linux
# >=5.14 supporting quotactl_fd. NEVER mkfs an existing device for this feature.
# Provision fresh storage separately and back up/migrate old files OFFLINE.
# Reserve project IDs 1000000..1999999999 exclusively for this broker.
# Legacy nonempty, unassigned session directories FAIL CLOSED and are retained.
# Migrate them offline into broker-created quota-provisioned sessions before
# allowing writes. Directory scans are NOT a hard quota and are not used.
# The broker checks actual fd-based XFS accounting, enforcement and hard limits
# inside its bind mount before creating each environment. No new env config.

root=/var/lib/chat-lite/table-sandbox
fail() { printf '%s\n' "sandbox storage prerequisite: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'run manually as host root'
command -v findmnt >/dev/null 2>&1 || fail 'findmnt is required'
command -v xfs_quota >/dev/null 2>&1 || fail 'xfsprogs is required for host verification'
[ -d "$root" ] && [ ! -L "$root" ] || fail "$root must already be a real mounted directory"
[ "$(findmnt -n -o TARGET --target "$root")" = "$root" ] || fail 'storage root must be a dedicated mountpoint (no automatic mounting)'
[ "$(findmnt -n -o FSTYPE --target "$root")" = xfs ] || fail 'storage root must be XFS'
options=$(findmnt -n -o OPTIONS --target "$root")
case ",$options," in *,prjquota,*|*,pquota,*) ;; *) fail 'XFS project quota must have enforcement enabled (prjquota)' ;; esac
case ",$options," in *,pqnoenforce,*) fail 'pqnoenforce is unsafe' ;; esac
xfs_quota -x -c 'state -p' "$root"
# Broker verifies actual kernel flags, not localized command output.
for child in jobs sessions; do
  [ ! -L "$root/$child" ] || fail "$child must not be a symlink"
  mkdir -p "$root/$child"
  chown root:root "$root/$child"
  chmod 755 "$root/$child"
done
chown root:root "$root"
chmod 755 "$root"
printf '%s\n' 'Host checks complete; broker must still verify quotactl_fd and install per-session 512MiB/32768-inode hard limits before any file writes.'
