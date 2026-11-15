//go:build !linux

package chat

import "os"

// Sandbox workspaces are Linux-only. Fail closed on other platforms instead
// of exposing a blocking special-file open in development builds.
func openWorkspaceFile(root *os.Root, name string, flags int, mode os.FileMode) (*os.File, error) {
	return nil, errScratch("工作区文件操作只支持 Linux")
}
