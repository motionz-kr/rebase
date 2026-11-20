//go:build !windows

// Package procgroup manages child process groups so a whole tree can be stopped.
package procgroup

import (
	"os/exec"
	"syscall"
)

// Configure places the child in its own process group.
func Configure(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// Kill sends SIGKILL to the whole process group.
func Kill(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// Terminate sends SIGTERM to the whole process group.
func Terminate(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
}
