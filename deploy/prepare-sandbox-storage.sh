#!/bin/sh
set -eu
# MANUAL HOST PREREQUISITE ONLY. NEVER mounts, formats, creates a loop device,
# modifies fstab, directories, permissions or quota state, or deletes files.
# Do NOT invoke from deploy/startup. This script ONLY CHECKS existing setup.
# Operator must provide a dedicated already-mounted XFS or ext4 filesystem at
# /var/lib/chat-lite/table-sandbox, with prjquota (XFS: not pqnoenforce), on Linux
# >=5.14 supporting quotactl_fd. NEVER mkfs an existing device for this feature.
# ext4 must ALREADY have both project and quota filesystem features, an
# internal project quota inode, and enforcement enabled with prjquota.
# NEVER run tune2fs to change features, mount/remount, or change the system disk
# from this script. Missing prerequisites require separate operator provisioning.
# Provision fresh storage separately and back up/migrate old files OFFLINE.
# Reserve project IDs 1000000..1999999999 exclusively for this broker.
# Legacy nonempty, unassigned session directories FAIL CLOSED and are retained.
# Migrate them offline into broker-created quota-provisioned sessions before
# allowing writes. Directory scans are NOT a hard quota and are not used.
# The broker checks actual fd-based accounting, enforcement and hard limits
# inside its bind mount before creating each environment. No new env config.

root=/var/lib/chat-lite/table-sandbox
fail() { printf '%s\n' "sandbox storage prerequisite: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'run manually as host root'
command -v findmnt >/dev/null 2>&1 || fail 'findmnt is required'
[ -d "$root" ] && [ ! -L "$root" ] || fail "$root must already be a real mounted directory"
[ "$(findmnt -n -o TARGET --target "$root")" = "$root" ] || fail 'storage root must be a dedicated mountpoint (no automatic mounting)'
[ "$(findmnt -n -o MAJ:MIN --target "$root")" != "$(findmnt -n -o MAJ:MIN --target /)" ] || fail 'storage must not share the system root filesystem, including via bind mount; provision dedicated storage separately'
fstype=$(findmnt -n -o FSTYPE --target "$root")
options=$(findmnt -n -o OPTIONS --target "$root")
case ",$options," in *,ro,*) fail 'storage must already be mounted read-write' ;; esac
case "$fstype" in
  xfs)
    command -v xfs_quota >/dev/null 2>&1 || fail 'xfsprogs is required for XFS host verification'
    case ",$options," in *,prjquota,*|*,pquota,*) ;; *) fail 'XFS project quota must have enforcement enabled (prjquota)' ;; esac
    case ",$options," in *,pqnoenforce,*) fail 'pqnoenforce is unsafe' ;; esac
    xfs_quota -x -c 'state -p' "$root"
    ;;
  ext4)
    command -v tune2fs >/dev/null 2>&1 || fail 'e2fsprogs (read-only tune2fs -l) is required for ext4 host verification'
    device=$(findmnt -n -o SOURCE --target "$root")
    [ -b "$device" ] || fail 'ext4 source must be an inspectable dedicated block device'
    details=$(LC_ALL=C tune2fs -l "$device") || fail 'cannot read ext4 filesystem features (no changes made)'
    features=$(printf '%s\n' "$details" | LC_ALL=C grep '^Filesystem features:') || fail 'cannot identify ext4 filesystem features'
    case " $features " in *' project '*) ;; *) fail 'ext4 is missing the project filesystem feature; provision dedicated storage separately/offline (no automatic tune2fs or mount)' ;; esac
    case " $features " in *' quota '*) ;; *) fail 'ext4 is missing the quota filesystem feature/internal quota inodes; provision dedicated storage separately/offline (no automatic tune2fs or mount)' ;; esac
    case ",$options," in *,prjquota,*) ;; *) fail 'ext4 project quota enforcement requires an already-configured prjquota mount; accounting alone is insufficient (no automatic remount)' ;; esac
    ;;
  *) fail 'storage root must be XFS or ext4 with enforced project quotas' ;;
esac
# Broker verifies actual kernel flags, not localized command output.
for child in jobs sessions; do
  [ -d "$root/$child" ] && [ ! -L "$root/$child" ] || fail "$child must already be a real directory; create it separately as root:root mode 755"
  [ "$(stat -c '%u:%g:%a' "$root/$child")" = '0:0:755' ] || fail "$child must already be root:root mode 755 (no automatic permission changes)"
done
[ "$(stat -c '%u:%g:%a' "$root")" = '0:0:755' ] || fail 'storage root must already be root:root mode 755 (no automatic permission changes)'
printf '%s\n' 'Host checks complete; broker must still verify quotactl_fd and install per-session 512MiB/32768-inode hard limits before any file writes.'
