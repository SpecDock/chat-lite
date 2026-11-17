#!/usr/bin/env python3
"""MANUAL, OFFLINE host migration; default is read-only dry-run.

Run as root after stopping app, broker AND all workers, disabling their restart
sources, and excluding host writers. Then run with --apply. This script never
starts services, formats an existing file/device, or deletes the old workspace.
It cannot prevent another administrator/daemon restarting a writer: the operator
must keep storage quiescent until app/broker have been recreated by deployment.
Only Linux amd64/arm64 with quotactl_fd (Linux >= 5.14) is supported.
"""

import argparse
import ctypes
import datetime
import fcntl
import hashlib
import json
import os
import platform
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile


ROOT = "/var/lib/chat-lite/table-sandbox"
IMAGE = ROOT + ".ext4.img"
GIB = 1024 ** 3
IMAGE_BYTES = 4 * GIB
LIMIT_BYTES = 512 * 1024 ** 2
LIMIT_INODES = 32768
INHERIT = 0x200
NOFOLLOW = os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0
DIRFLAGS = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
FSGET = 0x801C581F
FSSET = 0x401C5820
MOUNT_OPTIONS = "loop,prjquota,nosuid,nodev"
FSTAB_LINE = f"{IMAGE} {ROOT} ext4 {MOUNT_OPTIONS} 0 2\n".encode()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, pass_fds=()):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, pass_fds=pass_fds).stdout


def fingerprint(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid, s.st_gid,
            s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_blocks)


def open_relative(rootfd, relative, flags):
    """Do not follow symlinks in ANY component, including during final rechecks."""
    fd = os.dup(rootfd)
    try:
        parts = relative.split("/") if relative else []
        for i, part in enumerate(parts):
            require(part not in ("", ".", ".."), "unsafe relative path")
            nxt = os.open(part, flags if i == len(parts) - 1 else DIRFLAGS,
                          dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def digest_fd(fd):
    h = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            return h.hexdigest()
        h.update(chunk)


def inventory(rootfd):
    """Snapshot identities, metadata and hashes; the sole exception is broker socket."""
    result = {}
    device = os.fstat(rootfd).st_dev

    def walk(fd, relative):
        before = os.fstat(fd)
        require(before.st_dev == device, f"cross-filesystem directory: {relative}")
        result[relative] = (before, None)
        for name in sorted(os.listdir(fd)):
            rel = f"{relative}/{name}" if relative else name
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if rel == "table-sandbox.sock" and stat.S_ISSOCK(s.st_mode):
                continue  # stale runtime socket is retained only in the backup
            require(s.st_dev == device, f"cross-filesystem entry: {rel}")
            require(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode),
                    f"symlink/special file refused: {rel}")
            if stat.S_ISDIR(s.st_mode):
                child = os.open(name, DIRFLAGS, dir_fd=fd)
                try:
                    require(fingerprint(s) == fingerprint(os.fstat(child)),
                            f"directory changed: {rel}")
                    walk(child, rel)
                finally:
                    os.close(child)
            else:
                require(s.st_nlink == 1, f"hardlinked file refused: {rel}")
                require(not (rel == "jobs" or rel.startswith("jobs/")),
                        f"jobs contains a file/possibly valid job: {rel}; resolve manually")
                child = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=fd)
                try:
                    require(fingerprint(s) == fingerprint(os.fstat(child)),
                            f"file identity changed: {rel}")
                    digest = digest_fd(child)
                    require(fingerprint(s) == fingerprint(os.fstat(child)),
                            f"file changed while hashing: {rel}")
                    result[rel] = (s, digest)
                finally:
                    os.close(child)
        require(fingerprint(before) == fingerprint(os.fstat(fd)),
                f"directory changed during scan: {relative}")

    walk(rootfd, "")
    return result


def mounts():
    # mountinfo escapes whitespace/backslashes as octal sequences.
    def unescape(value):
        import re
        return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)
    with open("/proc/self/mountinfo", encoding="utf-8") as stream:
        return [unescape(line.split()[4]) for line in stream]


def overlapping(a, b):
    a, b = os.path.realpath(a), os.path.realpath(b)
    return os.path.commonpath((a, b)) in (a, b)


def check_docker():
    # Never let DOCKER_HOST/a remote CLI context inspect the wrong machine.
    docker = ("docker", "--host", "unix:///var/run/docker.sock")
    ids = run(*docker, "ps", "-q", "--no-trunc").split()
    for start in range(0, len(ids), 50):
        for container in json.loads(run(*docker, "inspect", *ids[start:start + 50])):
            for mount in container.get("Mounts", []):
                source = mount.get("Source", "")
                require(not source or not overlapping(source, ROOT),
                        f"running container uses source/ancestor/descendant: "
                        f"{container.get('Name')} ({source}); stop it first")


def check_fstab(raw):
    for line in raw.decode("utf-8").splitlines():
        fields = line.split("#", 1)[0].split()
        if fields:
            require(len(fields) >= 2, "malformed fstab entry; resolve manually")
            target = os.path.realpath(fields[1])
            require(target != ROOT and not target.startswith(ROOT + "/"),
                    f"fstab already contains sandbox/child mount: {line}")
            require(fields[0] != IMAGE, "fstab already references image; resolve manually")


def project_attrs(fd, project=None):
    buf = bytearray(28)
    fcntl.ioctl(fd, FSGET, buf, True)
    fields = list(struct.unpack("=5I8s", buf))
    if project is not None:
        fields[0] |= INHERIT
        fields[3] = project
        fcntl.ioctl(fd, FSSET, struct.pack("=5I8s", *fields))
        return project_attrs(fd)
    return fields[3], fields[0]


def quota_call(fd, cmd, project, buf):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # __NR_quotactl_fd = 443 on both supported 64-bit Linux ABIs.
    rc = libc.syscall(ctypes.c_long(443), ctypes.c_int(fd),
                      ctypes.c_uint((cmd << 8 | 2) & 0xFFFFFFFF),
                      ctypes.c_uint(project), ctypes.byref(buf))
    if rc != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def verify_enforcement(fd):
    info = ctypes.create_string_buffer(24)
    quota_call(fd, 0x800005, 0, info)  # Q_GETINFO
    _, _, flags, valid = struct.unpack("=QQII", info.raw)
    require(valid & 4 and flags & (1 << 16), "active internal quota inode missing")
    state = ctypes.create_string_buffer(160)
    state[0] = b"\x01"
    quota_call(fd, 0x5808, 0, state)  # Q_XGETQSTATV, same check as broker
    flags = struct.unpack_from("=H", state.raw, 2)[0]
    require(flags & 0x30 == 0x30, "project quota accounting/enforcement is not active")


def quota_limits(fd, project, install=False):
    if install:
        data = struct.pack("=8Q2I", LIMIT_BYTES // 1024, LIMIT_BYTES // 1024,
                           0, LIMIT_INODES, LIMIT_INODES, 0, 0, 0, 0x05, 0)
        quota_call(fd, 0x800008, project, ctypes.create_string_buffer(data, 72))
    buf = ctypes.create_string_buffer(72)
    quota_call(fd, 0x800007, project, buf)  # Q_GETQUOTA, 1KiB block limits
    hard, soft, used, ihard, isoft, inodes, _, _, valid, _ = struct.unpack("=8Q2I", buf.raw)
    require(valid & 0x0F == 0x0F and hard == soft == LIMIT_BYTES // 1024
            and ihard == isoft == LIMIT_INODES, f"quota readback failed: {project}")
    require(used <= LIMIT_BYTES and inodes <= LIMIT_INODES, "copied session exceeds quota")


def fsync_dir(path):
    fd = os.open(path, DIRFLAGS)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def metadata(fd, old):
    os.fchown(fd, old.st_uid, old.st_gid)
    os.fchmod(fd, stat.S_IMODE(old.st_mode))
    os.utime(fd, ns=(old.st_atime_ns, old.st_mtime_ns))
    os.fsync(fd)


def migrate(rootfd, target, entries, projects):
    for rel, (old, digest) in entries.items():
        if not rel:
            continue
        dest = os.path.join(target, rel)
        project = projects.get(rel.split("/")[1]) if rel.startswith("sessions/") else None
        if stat.S_ISDIR(old.st_mode):
            os.mkdir(dest, 0o700)
            fd = os.open(dest, DIRFLAGS)
            try:
                if rel.count("/") == 1 and rel.startswith("sessions/"):
                    quota_limits(fd, project, install=True)
                    project_attrs(fd, project)  # EMPTY root, before creating any children
                if project is not None:
                    pid, flags = project_attrs(fd)
                    require(pid == project and flags & INHERIT, f"directory inheritance lost: {rel}")
            finally:
                os.close(fd)
        else:
            srcfd = open_relative(rootfd, rel, os.O_RDONLY | NOFOLLOW)
            dstfd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
            try:
                require(fingerprint(os.fstat(srcfd)) == fingerprint(old), f"source changed: {rel}")
                h = hashlib.sha256()
                while True:
                    chunk = os.read(srcfd, 1024 * 1024)
                    if not chunk:
                        break
                    h.update(chunk)
                    view = memoryview(chunk)
                    while view:
                        written = os.write(dstfd, view)
                        require(written > 0, "short write")
                        view = view[written:]
                require(h.hexdigest() == digest and fingerprint(os.fstat(srcfd)) == fingerprint(old),
                        f"source changed while copying: {rel}")
                metadata(dstfd, old)
            finally:
                os.close(srcfd)
                os.close(dstfd)
    # Restore directory metadata AFTER populating children (including session root).
    for rel, (old, _) in reversed(list(entries.items())):
        if stat.S_ISDIR(old.st_mode):
            fd = os.open(os.path.join(target, rel), DIRFLAGS)
            try:
                metadata(fd, old)
            finally:
                os.close(fd)


def verify_copy(target, entries, projects):
    for rel, (old, digest) in entries.items():
        fd = os.open(os.path.join(target, rel), DIRFLAGS if stat.S_ISDIR(old.st_mode)
                     else os.O_RDONLY | NOFOLLOW)
        try:
            new = os.fstat(fd)
            require((new.st_uid, new.st_gid, new.st_mode, new.st_mtime_ns) ==
                    (old.st_uid, old.st_gid, old.st_mode, old.st_mtime_ns),
                    f"copied metadata mismatch: {rel}")
            if digest is not None:
                require(new.st_size == old.st_size and digest_fd(fd) == digest,
                        f"copied file size/SHA256 mismatch: {rel}")
            if rel.startswith("sessions/"):
                project = projects[rel.split("/")[1]]
                pid, flags = project_attrs(fd)
                require(pid == project and (not stat.S_ISDIR(new.st_mode) or flags & INHERIT),
                        f"copied project inheritance mismatch: {rel}")
        finally:
            os.close(fd)


def write_exclusive(path, content, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform offline migration (default: dry-run)")
    args = parser.parse_args()
    stage = "preflight"
    temporary = backup = fstab_backup = None
    temporary_mounted = final_mounted = renamed = new_root = False
    imagefd = sourcefd = fstabfd = lockfd = None
    fstab_before = fstab_after = None
    try:
        require(sys.platform == "linux" and platform.machine() in ("x86_64", "aarch64"),
                "requires Linux amd64/arm64 quota ABI")
        require(os.geteuid() == 0, "run manually as host root")
        for tool in ("docker", "fallocate", "mkfs.ext4", "mount", "umount"):
            require(shutil.which(tool), f"missing command: {tool}")
        for path in ("/var", "/var/lib", "/var/lib/chat-lite"):
            s = os.lstat(path)
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022,
                    f"requires trusted root-owned non-writable parent: {path}")
        require(not os.path.lexists(IMAGE), "image already exists; NEVER format/reuse it; inspect manually")
        require(not os.path.lexists(ROOT + "/quota-projects.json"),
                "legacy quota registry exists; manual reconciliation required")
        require(not any(p == ROOT or p.startswith(ROOT + "/") for p in mounts()),
                "source is already a mountpoint or contains nested mounts; resolve manually")
        sourcefd = os.open(ROOT, DIRFLAGS)
        check_docker()
        entries = inventory(sourcefd)
        top = {rel for rel in entries if rel and "/" not in rel}
        require(top == {"jobs", "sessions"}, f"unexpected root entries: {sorted(top)}")
        for rel in ("", "jobs", "sessions"):
            s = entries[rel][0]
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0
                    and stat.S_IMODE(s.st_mode) == 0o755,
                    f"broker requires root:root directory mode 755: {rel or ROOT}")
        sessions = sorted(rel.split("/")[1] for rel, (s, _) in entries.items()
                          if rel.startswith("sessions/") and rel.count("/") == 1
                          and stat.S_ISDIR(s.st_mode))
        require(all(stat.S_ISDIR(s.st_mode) for rel, (s, _) in entries.items()
                    if rel.startswith("sessions/") and rel.count("/") == 1),
                "sessions must contain directories only")
        projects = {name: 1000000 + i for i, name in enumerate(sessions)}
        require(1000000 + len(projects) < 2000000000, "project ID range exhausted")
        copy_bytes = 0
        for name in sessions:
            items = [s for rel, (s, _) in entries.items()
                     if rel == "sessions/" + name or rel.startswith("sessions/" + name + "/")]
            logical = sum(s.st_size for s in items if stat.S_ISREG(s.st_mode))
            allocated = sum(s.st_blocks * 512 for s in items)
            require(max(logical, allocated) <= LIMIT_BYTES and len(items) <= LIMIT_INODES,
                    f"session {name!r} exceeds 512MiB/32768 inodes; old data retained")
        for s, _ in entries.values():
            copy_bytes += max(s.st_blocks * 512, ((s.st_size + 4095) // 4096) * 4096, 4096)
        available = os.statvfs(os.path.dirname(ROOT))
        free = available.f_bavail * available.f_frsize
        require(free >= IMAGE_BYTES + copy_bytes + 2 * GIB,
                f"insufficient disk: free={free}, need image 4GiB + copy {copy_bytes} + 2GiB")
        require(copy_bytes < IMAGE_BYTES - 512 * 1024 ** 2,
                "copy estimate leaves insufficient ext4 metadata/headroom in 4GiB image")
        fstabfd = os.open("/etc/fstab", (os.O_RDWR if args.apply else os.O_RDONLY) | NOFOLLOW)
        require(stat.S_ISREG(os.fstat(fstabfd).st_mode), "fstab must be a regular file")
        if args.apply:
            fcntl.flock(fstabfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with os.fdopen(os.dup(fstabfd), "rb") as stream:
            fstab_before = stream.read()
        check_fstab(fstab_before)
        print(f"Preflight: {len(projects)} sessions; copy estimate {copy_bytes} bytes; free {free} bytes.")
        print("Old broker socket is NOT copied; jobs contains directories only; no legacy registry.")
        print("Operator must keep app/broker/workers and host writers stopped; this cannot be guaranteed by a script.")
        if not args.apply:
            print("DRY-RUN ONLY: no image, mounts, directories, quota or fstab changes. Use --apply offline.")
            return 0

        lockfd = os.open("/run/lock/chat-lite-sandbox-migration.lock",
                         os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup = ROOT + ".backup-" + stamp
        fstab_backup = "/etc/fstab.chat-lite-before-" + stamp
        require(not os.path.lexists(backup), "backup path exists")
        stage = "allocate NEW exclusive 4GiB image"
        imagefd = os.open(IMAGE, os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        require(stat.S_ISREG(os.fstat(imagefd).st_mode), "new image is not a regular file")
        fdpath = f"/proc/self/fd/{imagefd}"
        run("fallocate", "-l", str(IMAGE_BYTES), fdpath, pass_fds=(imagefd,))
        s = os.fstat(imagefd)
        require(s.st_size == IMAGE_BYTES and s.st_blocks * 512 >= IMAGE_BYTES,
                "4GiB was not actually reserved (sparse/compressed image refused)")
        os.fsync(imagefd)
        fsync_dir(os.path.dirname(IMAGE))
        stage = "format ONLY newly O_EXCL-created regular image"
        run("mkfs.ext4", "-F", "-O", "quota,project", "-E", "nodiscard,quotatype=prjquota", fdpath, pass_fds=(imagefd,))
        os.fsync(imagefd)
        stage = "temporary loop mount and quota enforcement"
        temporary = tempfile.mkdtemp(prefix=".table-sandbox-migrate-", dir=os.path.dirname(ROOT))
        require(not os.listdir(temporary), "temporary mount directory is not empty")
        image_stat = os.stat(IMAGE, follow_symlinks=False)
        require((image_stat.st_dev, image_stat.st_ino) ==
                (os.fstat(imagefd).st_dev, os.fstat(imagefd).st_ino),
                "image path identity changed")
        run("mount", "-t", "ext4", "-o", MOUNT_OPTIONS, IMAGE, temporary)
        temporary_mounted = True
        fd = os.open(temporary, DIRFLAGS)
        try:
            verify_enforcement(fd)
        finally:
            os.close(fd)
        stage = "copy into quota-provisioned empty sessions"
        migrate(sourcefd, temporary, entries, projects)
        stage = "verify every file SHA256, metadata, project inheritance and limits"
        verify_copy(temporary, entries, projects)
        for name, project in projects.items():
            fd = os.open(os.path.join(temporary, "sessions", name), DIRFLAGS)
            try:
                quota_limits(fd, project)
            finally:
                os.close(fd)
        registry = json.dumps({"next": 1000000 + len(projects), "projects": projects},
                              sort_keys=True, ensure_ascii=True).encode() + b"\n"
        write_exclusive(os.path.join(temporary, "quota-projects.json"), registry)
        # Registry creation changes root mtime; retain original metadata afterwards.
        fd = os.open(temporary, DIRFLAGS)
        try:
            metadata(fd, entries[""][0])
        finally:
            os.close(fd)
        stage = "final offline/source identity recheck"
        check_docker()
        current = inventory(sourcefd)
        require({p: (fingerprint(s), h) for p, (s, h) in current.items()} ==
                {p: (fingerprint(s), h) for p, (s, h) in entries.items()},
                "source changed since preflight; refusing cutover")
        require(fingerprint(os.stat(ROOT, follow_symlinks=False)) == fingerprint(os.fstat(sourcefd)),
                "source root path replaced")
        stage = "unmount temporary, retain old directory and mount new root"
        run("umount", temporary)
        temporary_mounted = False
        os.rename(ROOT, backup)
        renamed = True
        fsync_dir(os.path.dirname(ROOT))
        os.mkdir(ROOT, 0o755)
        new_root = True
        run("mount", "-t", "ext4", "-o", MOUNT_OPTIONS, IMAGE, ROOT)
        final_mounted = True
        fd = os.open(ROOT, DIRFLAGS)
        try:
            verify_enforcement(fd)
        finally:
            os.close(fd)
        with open(os.path.join(ROOT, "quota-projects.json"), "rb") as stream:
            require(stream.read() == registry, "registry readback after remount failed")
        stage = "backup and append fstab (never replace other entries)"
        os.lseek(fstabfd, 0, os.SEEK_SET)
        with os.fdopen(os.dup(fstabfd), "rb") as stream:
            require(stream.read() == fstab_before, "fstab changed during migration")
        require(os.stat("/etc/fstab", follow_symlinks=False).st_ino == os.fstat(fstabfd).st_ino,
                "fstab path replaced during migration")
        write_exclusive(fstab_backup, fstab_before)
        fsync_dir("/etc")
        fstab_after = fstab_before + (b"\n" if fstab_before and not fstab_before.endswith(b"\n") else b"") + FSTAB_LINE
        os.lseek(fstabfd, 0, os.SEEK_END)
        with os.fdopen(os.dup(fstabfd), "ab") as stream:
            stream.write(fstab_after[len(fstab_before):])
            stream.flush()
            os.fsync(stream.fileno())
        fsync_dir(os.path.dirname(ROOT))
        print(f"SUCCESS: mounted {IMAGE} at {ROOT}; fstab backup: {fstab_backup}")
        print(f"OLD DATA RETAINED (never auto-deleted): {backup}")
        print("Next: deployment operator recreates app/broker bind mounts, controls service startup,")
        print("and confirms broker quota admission. No services were started; do not reuse stale containers.")
        return 0
    except BaseException as error:
        print(f"FAILED at stage [{stage}]: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr or error.stdout, file=sys.stderr)
        # Each recovery is independent; never hide an unmount failure with lazy/force.
        def recover(label, action):
            try:
                action()
                return True
            except BaseException as recovery_error:
                print(f"MANUAL RECOVERY REQUIRED ({label}): {recovery_error}", file=sys.stderr)
                return False
        if fstab_after is not None:
            def restore_fstab():
                os.lseek(fstabfd, 0, os.SEEK_SET)
                with os.fdopen(os.dup(fstabfd), "rb") as stream:
                    now = stream.read()
                require(now == fstab_after or (now.startswith(fstab_before) and fstab_after.startswith(now)),
                        "fstab has unrelated edits; refusing to overwrite them")
                os.ftruncate(fstabfd, len(fstab_before))
                os.fsync(fstabfd)
            recover("restore original fstab bytes", restore_fstab)
        if final_mounted and recover("unmount new root", lambda: run("umount", ROOT)):
            final_mounted = False
        if renamed and not final_mounted:
            if not new_root or recover("remove only empty new mountpoint", lambda: os.rmdir(ROOT)):
                recover("rename old backup back to root", lambda: os.rename(backup, ROOT))
                recover("fsync restored parent", lambda: fsync_dir(os.path.dirname(ROOT)))
        if temporary_mounted and recover("unmount temporary volume", lambda: run("umount", temporary)):
            temporary_mounted = False
        print(f"No old data deleted. Backup path (if cutover reached): {backup}", file=sys.stderr)
        print(f"New image retained if created: {IMAGE}; inspect manually before any retry.", file=sys.stderr)
        if temporary:
            print(f"Temporary mount path (inspect if recovery failed): {temporary}", file=sys.stderr)
        print("Keep services STOPPED; verify mounts/directories/fstab before manual recovery.", file=sys.stderr)
        return 1
    finally:
        if temporary and not temporary_mounted:
            try:
                os.rmdir(temporary)  # only empty staging mountpoint, never recursive deletion
            except OSError:
                pass
        for fd in (sourcefd, imagefd, fstabfd, lockfd):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise RuntimeError(f"interrupted by signal {signum}; attempting offline rollback")
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    sys.exit(main())
