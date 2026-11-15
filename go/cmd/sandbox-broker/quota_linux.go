//go:build linux

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ABI sources (Linux UAPI; no C compiler or architecture-dependent C struct packing):
// https://github.com/torvalds/linux/blob/v6.1/include/uapi/linux/dqblk_xfs.h
// https://github.com/torvalds/linux/blob/v6.1/include/uapi/linux/fs.h
// https://github.com/torvalds/linux/blob/v6.1/include/uapi/linux/quota.h
// quotactl_fd(fd, QCMD(cmd, PRJQUOTA), id, address) works on a bind-mounted
// directory fd, without a block device or container-visible mount table entry.
// Q_XGETQSTATV v1 is 160 bytes; fs_disk_quota v1 is 112 bytes, blocks are 512B.
// Only amd64/arm64 UAPI ioctl encoding is supported. Other ABIs fail closed.
const quotaRegistryPath = "/run/table-sandbox/quota-projects.json"
const quotaBlocks = 512 * 1024 * 1024 / 512
const quotaInodes = 32768
const projectInherit = 0x200

type fsxattr struct {
	Flags, Extsize, Nextents, ProjectID, CowExtsize uint32
	Pad                                             [8]byte
}
type quotaRegistry struct {
	Next     uint32            `json:"next"`
	Projects map[string]uint32 `json:"projects"`
}

var quotaMu sync.Mutex

func quotaCall(fd int, cmd, id uint32, data unsafe.Pointer) error {
	_, _, errno := unix.Syscall6(unix.SYS_QUOTACTL_FD, uintptr(fd), uintptr(cmd<<8|2), uintptr(id), uintptr(data), 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
func quotaIOCTL(fd int, cmd uintptr, x *fsxattr) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), cmd, uintptr(unsafe.Pointer(x)))
	if errno != 0 {
		return errno
	}
	return nil
}
func prepareQuota(root, id string) error {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return errors.New("unsupported Linux quota ABI (requires amd64/arm64)")
	}
	quotaMu.Lock()
	defer quotaMu.Unlock()
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var fs unix.Statfs_t
	if err = unix.Fstatfs(fd, &fs); err != nil {
		return err
	}
	if fs.Type != unix.XFS_SUPER_MAGIC {
		return errors.New("session storage is not XFS; hard project quota cannot be enforced")
	}
	var stat [20]uint64
	sb := unsafe.Slice((*byte)(unsafe.Pointer(&stat[0])), 160)
	sb[0] = 1
	if err = quotaCall(fd, 0x5808, 0, unsafe.Pointer(&stat[0])); err != nil {
		return fmt.Errorf("Q_XGETQSTATV: %w", err)
	}
	flags := binary.NativeEndian.Uint16(sb[2:4])
	if flags&0x30 != 0x30 {
		return errors.New("XFS project quota accounting AND enforcement must be enabled (mount prjquota, not pqnoenforce)")
	}
	registry := quotaRegistry{Next: 1000000, Projects: map[string]uint32{}}
	raw, err := os.ReadFile(quotaRegistryPath)
	if err == nil {
		if err = json.Unmarshal(raw, &registry); err != nil {
			return fmt.Errorf("invalid quota registry: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if registry.Projects == nil || registry.Next < 1000000 {
		return errors.New("invalid quota project registry")
	}
	project := registry.Projects[id]
	var attrs fsxattr
	if err = quotaIOCTL(fd, 0x801c581f, &attrs); err != nil {
		return fmt.Errorf("FSGETXATTR: %w", err)
	}
	if project == 0 {
		if attrs.ProjectID != 0 {
			return errors.New("unregistered project ID on session directory; manual storage repair required")
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return errors.New("legacy unquoted session contains files; operator must migrate it offline to an empty quota-provisioned session (files were NOT removed)")
		}
		project = registry.Next
		if project >= 2000000000 {
			return errors.New("sandbox project ID range exhausted")
		}
		var existing [14]uint64
		err = quotaCall(fd, 0x5803, project, unsafe.Pointer(&existing[0]))
		if err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("check unused project ID: %w", err)
		}
		if err == nil {
			b := unsafe.Slice((*byte)(unsafe.Pointer(&existing[0])), 112)
			for _, v := range b[8:56] {
				if v != 0 {
					return errors.New("reserved sandbox project ID already used; dedicated filesystem/range required")
				}
			}
		}
		registry.Next++
		registry.Projects[id] = project
		encoded, _ := json.Marshal(registry)
		tmp := quotaRegistryPath + ".tmp"
		f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = f.Write(encoded)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = os.Rename(tmp, quotaRegistryPath); err != nil {
			return err
		}
		parent, err := os.Open(filepath.Dir(quotaRegistryPath))
		if err != nil {
			return err
		}
		err = parent.Sync()
		_ = parent.Close()
		if err != nil {
			return err
		}
	}
	// A crash may have persisted the registry before assigning the empty root.
	if attrs.ProjectID == 0 {
		entries, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return errors.New("unassigned session has files; refusing unsafe quota adoption")
		}
		var disk [14]uint64
		db := unsafe.Slice((*byte)(unsafe.Pointer(&disk[0])), 112)
		db[0] = 1
		db[1] = 2
		binary.NativeEndian.PutUint16(db[2:4], 0x0f)
		binary.NativeEndian.PutUint32(db[4:8], project)
		binary.NativeEndian.PutUint64(db[8:16], quotaBlocks)
		binary.NativeEndian.PutUint64(db[16:24], quotaBlocks)
		binary.NativeEndian.PutUint64(db[24:32], quotaInodes)
		binary.NativeEndian.PutUint64(db[32:40], quotaInodes)
		if err = quotaCall(fd, 0x5804, project, unsafe.Pointer(&disk[0])); err != nil {
			return fmt.Errorf("set 512MiB/32768-inode hard limits: %w", err)
		}
		attrs.ProjectID = project
		attrs.Flags |= projectInherit
		if err = quotaIOCTL(fd, 0x401c5820, &attrs); err != nil {
			return fmt.Errorf("FSSETXATTR project inheritance: %w", err)
		}
	}
	if err = quotaIOCTL(fd, 0x801c581f, &attrs); err != nil {
		return fmt.Errorf("verify project inheritance: %w", err)
	}
	if attrs.ProjectID != project || attrs.Flags&projectInherit == 0 {
		return errors.New("session project identity/inheritance mismatch")
	}
	var disk [14]uint64
	if err = quotaCall(fd, 0x5803, project, unsafe.Pointer(&disk[0])); err != nil {
		return fmt.Errorf("verify hard project quota: %w", err)
	}
	db := unsafe.Slice((*byte)(unsafe.Pointer(&disk[0])), 112)
	if binary.NativeEndian.Uint64(db[8:16]) != quotaBlocks || binary.NativeEndian.Uint64(db[24:32]) != quotaInodes {
		return errors.New("session hard quota limits differ from 512MiB/32768 inodes")
	}
	return nil
}
