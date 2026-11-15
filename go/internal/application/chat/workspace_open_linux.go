//go:build linux

package chat

import (
	"os"

	"golang.org/x/sys/unix"
)

// O_NONBLOCK prevents worker-created FIFOs from blocking before fstat. Do not
// truncate, chmod, read, or write until the opened descriptor is verified.
func openWorkspaceFile(root *os.Root, name string, flags int, mode os.FileMode) (*os.File, error) {
	// Avoid opening a known device/socket/FIFO at all. This precheck is not
	// trusted against races: O_NONBLOCK plus descriptor fstat remain mandatory.
	if info, err := root.Stat(name); err == nil {
		if !info.Mode().IsRegular() {
			return nil, errScratch("只允许普通文件")
		}
	} else if !os.IsNotExist(err) || flags&os.O_CREATE == 0 {
		return nil, err
	}
	f, err := root.OpenFile(name, flags|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_NOFOLLOW, mode)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		if err == nil {
			err = errScratch("只允许普通文件")
		}
		return nil, err
	}
	return f, nil
}
