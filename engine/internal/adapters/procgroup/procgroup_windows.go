// Package procgroup manages child process groups so a whole tree can be stopped.
package procgroup

import (
	"context"
	"os/exec"
	"strconv"
	"time"
)

// Configure is a no-op on Windows; taskkill /T stops the tree.
func Configure(cmd *exec.Cmd) {}

// Kill force-stops the process tree.
func Kill(cmd *exec.Cmd) {
	if cmd.Process != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
		_ = cmd.Process.Kill()
	}
}

// Terminate stops the process tree (Windows has no graceful group signal).
func Terminate(cmd *exec.Cmd) { Kill(cmd) }
