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
// ext4 uses if_dqinfo (24B), if_dqblk (72B), and 1024B limit blocks.
// Q_GETINFO reports accounting, NOT enforcement. Both filesystems must also
// pass Q_XGETQSTATV: generic fs/quota/quota.c maps ext4's dquot_get_state
// QCI_LIMITS_ENFORCED to FS_QUOTA_PDQ_ENFD. See Linux v6.1:
// https://github.com/torvalds/linux/blob/v6.1/fs/quota/quota.c
// https://github.com/torvalds/linux/blob/v6.1/fs/quota/dquot.c
// https://github.com/torvalds/linux/blob/v6.1/fs/ext4/super.c
// Only amd64/arm64 UAPI ioctl encoding is supported. Other ABIs fail closed.
const quotaRegistryPath = "/run/table-sandbox/quota-projects.json"
const quotaBytes = 512 * 1024 * 1024
const quotaBlocks = quotaBytes / 512
const quotaInodes = 32768
const projectInherit = 0x200

// Linux UAPI if_dqblk; explicit tail padding for the supported 64-bit ABIs.
type genericDQBlk struct {
	BlockHard, BlockSoft, Space, InodeHard, InodeSoft, Inodes, BlockTime, InodeTime uint64
	Valid, Pad                                                                      uint32
}

type genericDQInfo struct {
	BlockGrace, InodeGrace uint64
	Flags, Valid           uint32
}

// Block limits/usage use the backend's native units; only zero usage is tested.
type projectQuota struct {
	BlockHard, BlockSoft, InodeHard, InodeSoft, Space, Inodes uint64
}

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

func getProjectQuota(fd int, project uint32, ext4 bool) (projectQuota, error) {
	if ext4 {
		var disk genericDQBlk
		if err := quotaCall(fd, 0x800007, project, unsafe.Pointer(&disk)); err != nil {
			return projectQuota{}, err
		}
		// QIF_BLIMITS | QIF_SPACE | QIF_ILIMITS | QIF_INODES.
		if disk.Valid&0x0f != 0x0f {
			return projectQuota{}, errors.New("incomplete Q_GETQUOTA limits/usage")
		}
		return projectQuota{disk.BlockHard, disk.BlockSoft, disk.InodeHard, disk.InodeSoft, disk.Space, disk.Inodes}, nil
	}
	var disk [14]uint64
	if err := quotaCall(fd, 0x5803, project, unsafe.Pointer(&disk[0])); err != nil {
		return projectQuota{}, err
	}
	db := unsafe.Slice((*byte)(unsafe.Pointer(&disk[0])), 112)
	return projectQuota{
		binary.NativeEndian.Uint64(db[8:16]), binary.NativeEndian.Uint64(db[16:24]),
		binary.NativeEndian.Uint64(db[24:32]), binary.NativeEndian.Uint64(db[32:40]),
		binary.NativeEndian.Uint64(db[40:48]), binary.NativeEndian.Uint64(db[48:56]),
	}, nil
}

func setProjectQuota(fd int, project uint32, ext4 bool) error {
	if ext4 {
		disk := genericDQBlk{
			BlockHard: quotaBytes / 1024, BlockSoft: quotaBytes / 1024,
			InodeHard: quotaInodes, InodeSoft: quotaInodes,
			Valid: 0x05, // QIF_BLIMITS | QIF_ILIMITS; never overwrite usage/timers.
		}
		return quotaCall(fd, 0x800008, project, unsafe.Pointer(&disk))
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
	return quotaCall(fd, 0x5804, project, unsafe.Pointer(&disk[0]))
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
	ext4 := fs.Type == unix.EXT4_SUPER_MAGIC
	if fs.Type != unix.XFS_SUPER_MAGIC && !ext4 {
		return errors.New("session storage must be XFS or ext4 with enforced project quotas")
	}
	if ext4 {
		var info genericDQInfo
		if err = quotaCall(fd, 0x800005, 0, unsafe.Pointer(&info)); err != nil {
			return fmt.Errorf("ext4 Q_GETINFO: project/quota filesystem features and active project quotas are required: %w", err)
		}
		if info.Valid&4 == 0 || info.Flags&(1<<16) == 0 {
			return errors.New("ext4 project quotas must use an active internal quota inode (filesystem project/quota features required)")
		}
	}
	var stat [20]uint64
	sb := unsafe.Slice((*byte)(unsafe.Pointer(&stat[0])), 160)
	sb[0] = 1
	if err = quotaCall(fd, 0x5808, 0, unsafe.Pointer(&stat[0])); err != nil {
		return fmt.Errorf("Q_XGETQSTATV: %w", err)
	}
	flags := binary.NativeEndian.Uint16(sb[2:4])
	if flags&0x30 != 0x30 {
		return errors.New("project quota accounting AND enforcement must be enabled (XFS: prjquota, not pqnoenforce; ext4: project/quota features and prjquota)")
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
		existing, err := getProjectQuota(fd, project, ext4)
		if err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("check unused project ID: %w", err)
		}
		if err == nil && existing != (projectQuota{}) {
			return errors.New("reserved sandbox project ID already used; dedicated filesystem/range required")
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
		if err = setProjectQuota(fd, project, ext4); err != nil {
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
	disk, err := getProjectQuota(fd, project, ext4)
	if err != nil {
		return fmt.Errorf("verify hard project quota: %w", err)
	}
	var blockLimit uint64 = quotaBlocks
	if ext4 {
		blockLimit = quotaBytes / 1024
	}
	if disk.BlockHard != blockLimit || disk.InodeHard != quotaInodes {
		return errors.New("session hard quota limits differ from 512MiB/32768 inodes")
	}
	return nil
}
