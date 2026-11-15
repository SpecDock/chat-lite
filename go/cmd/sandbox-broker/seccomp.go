package main

import "encoding/json"

// Default-deny rather than weakening Docker's default profile. In particular,
// FSSETXATTR/SETFLAGS ioctls must NEVER be available to uid 1000: clearing
// PROJINHERIT on a user-owned directory would bypass the project hard quota.
// No mount, unshare, setns, ptrace, bpf, keyctl, io_uring or new namespace clone.
func workerSeccomp() string {
	allow := []string{
		"read", "write", "readv", "writev", "pread64", "pwrite64", "preadv", "pwritev", "preadv2", "pwritev2", "close", "close_range", "lseek",
		"open", "openat", "openat2", "creat", "stat", "lstat", "fstat", "newfstatat", "statx", "statfs", "fstatfs", "access", "faccessat", "faccessat2", "readlink", "readlinkat", "getdents", "getdents64", "getcwd", "chdir", "fchdir",
		"mkdir", "mkdirat", "rmdir", "unlink", "unlinkat", "rename", "renameat", "renameat2", "link", "linkat", "symlink", "symlinkat", "chmod", "fchmod", "fchmodat", "fchmodat2", "chown", "fchown", "lchown", "fchownat", "umask", "truncate", "ftruncate", "fallocate", "fsync", "fdatasync", "sync_file_range", "utime", "utimes", "futimesat", "utimensat", "flock", "fcntl", "dup", "dup2", "dup3", "pipe", "pipe2", "sendfile", "copy_file_range", "splice", "tee", "vmsplice",
		"mmap", "mprotect", "munmap", "mremap", "madvise", "brk", "msync", "mincore", "mlock", "munlock", "mlock2", "membarrier", "get_mempolicy",
		"rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "rt_sigpending", "rt_sigtimedwait", "rt_sigsuspend", "rt_sigqueueinfo", "rt_tgsigqueueinfo", "sigaltstack", "signalfd4", "restart_syscall",
		"futex", "futex_waitv", "set_robust_list", "get_robust_list", "rseq", "set_tid_address", "arch_prctl", "prctl", "capget", "capset",
		"fork", "vfork", "execve", "execveat", "wait4", "waitid", "exit", "exit_group", "kill", "tkill", "tgkill", "pidfd_open", "pidfd_send_signal",
		"getpid", "getppid", "gettid", "getuid", "geteuid", "getgid", "getegid", "getresuid", "getresgid", "getgroups", "setuid", "setgid", "setreuid", "setregid", "setresuid", "setresgid", "setgroups", "setfsuid", "setfsgid", "setsid", "getsid", "setpgid", "getpgid", "getpgrp",
		"socket", "socketpair", "connect", "bind", "listen", "accept", "accept4", "shutdown", "sendto", "recvfrom", "sendmsg", "recvmsg", "sendmmsg", "recvmmsg", "getsockname", "getpeername", "getsockopt", "setsockopt",
		"poll", "ppoll", "select", "pselect6", "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait", "epoll_pwait", "epoll_pwait2", "eventfd", "eventfd2", "timerfd_create", "timerfd_settime", "timerfd_gettime",
		"clock_gettime", "clock_getres", "clock_nanosleep", "nanosleep", "gettimeofday", "time", "times", "getrusage", "getrlimit", "setrlimit", "prlimit64", "uname", "sysinfo", "getrandom", "getcpu", "sched_yield", "sched_getaffinity", "sched_setaffinity", "sched_getparam", "sched_getscheduler", "sched_get_priority_max", "sched_get_priority_min", "sched_rr_get_interval", "sched_setscheduler", "sched_setparam", "getpriority", "setpriority", "alarm", "setitimer", "getitimer", "timer_create", "timer_delete", "timer_settime", "timer_gettime", "timer_getoverrun",
		"inotify_init", "inotify_init1", "inotify_add_watch", "inotify_rm_watch", "memfd_create", "fadvise64", "readahead", "getxattr", "lgetxattr", "fgetxattr", "listxattr", "llistxattr", "flistxattr", "setxattr", "lsetxattr", "fsetxattr", "removexattr", "lremovexattr", "fremovexattr", "syslog",
	}
	rules := []any{map[string]any{"names": allow, "action": "SCMP_ACT_ALLOW"}, map[string]any{"names": []string{"clone"}, "action": "SCMP_ACT_ALLOW", "args": []any{map[string]any{"index": 0, "value": 0x7e020000, "valueTwo": 0, "op": "SCMP_CMP_MASKED_EQ"}}}, map[string]any{"names": []string{"clone3"}, "action": "SCMP_ACT_ERRNO", "errnoRet": 38}}
	// Narrow read-only terminal/socket queries; no generic ioctl grant.
	for _, request := range []int{0x5401, 0x5413, 0x541b, 0x5451, 0x8933} {
		rules = append(rules, map[string]any{"names": []string{"ioctl"}, "action": "SCMP_ACT_ALLOW", "args": []any{map[string]any{"index": 1, "value": request, "op": "SCMP_CMP_EQ"}}})
	}
	raw, _ := json.Marshal(map[string]any{"defaultAction": "SCMP_ACT_ERRNO", "defaultErrnoRet": 1, "syscalls": rules})
	return "seccomp=" + string(raw)
}
