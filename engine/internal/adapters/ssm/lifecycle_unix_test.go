//go:build !windows

package ssm

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// Models an AWS CLI parent that exits while a plugin keeps its inherited pipes
// and listener open, or a CLI that does not respond to SIGTERM.
func TestSSMDescendantHelper(t *testing.T) {
	mode := os.Getenv("REBASE_SSM_DESCENDANT_MODE")
	if mode == "" {
		return
	}
	if mode == "parent" {
		exe, _ := os.Executable()
		cmd := exec.Command(exe, "-test.run=^TestSSMDescendantHelper$", "--", os.Args[len(os.Args)-1])
		cmd.Env = append(os.Environ(), "REBASE_SSM_DESCENDANT_MODE=child")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if cmd.Start() != nil {
			os.Exit(1)
		}
		_ = os.WriteFile(os.Getenv("REBASE_SSM_CHILD_PID"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600)
		for {
			if _, err := os.Stat(os.Getenv("REBASE_SSM_PARENT_EXIT")); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	signal.Ignore(syscall.SIGTERM)
	ln, err := net.Listen("tcp", "127.0.0.1:"+os.Args[len(os.Args)-1])
	if err != nil {
		os.Exit(1)
	}
	fmt.Println("Waiting for connections...")
	for {
		c, err := ln.Accept()
		if err != nil {
			os.Exit(0)
		}
		_ = c.Close()
	}
}

func descendantManager(t *testing.T, mode string) (*Manager, string) {
	t.Helper()
	m := helperManager(t)
	exitFile, pidFile := filepath.Join(t.TempDir(), "exit"), filepath.Join(t.TempDir(), "pid")
	factory := m.command
	m.command = func(name string, args ...string) *exec.Cmd {
		cmd := factory(name, args...)
		cmd.Args[1] = "-test.run=^TestSSMDescendantHelper$"
		cmd.Env = append(cmd.Env, "REBASE_SSM_DESCENDANT_MODE="+mode, "REBASE_SSM_PARENT_EXIT="+exitFile, "REBASE_SSM_CHILD_PID="+pidFile)
		return cmd
	}
	// Runs even on the RED assertion, so the intentionally stubborn child never leaks.
	t.Cleanup(func() {
		if data, err := os.ReadFile(pidFile); err == nil {
			pid, _ := strconv.Atoi(string(data))
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return m, exitFile
}

func assertPortClosed(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 50*time.Millisecond)
		if err != nil {
			return
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			t.Fatalf("SSM process still listens on %d after cleanup", port)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCloseProfileKillsPluginAfterCLIExits(t *testing.T) {
	m, exitFile := descendantManager(t, "parent")
	ep, err := m.ResolveEndpoint(context.Background(), ssmProfile())
	if err != nil {
		t.Fatal(err)
	}
	e := m.entries[tunnelKey(ssmProfile())]
	if err = os.WriteFile(exitFile, []byte("exit"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-e.session.done:
	case <-time.After(3 * time.Second):
		t.Fatal("CLI parent did not exit")
	}
	m.CloseProfile(ssmProfile().ID)
	assertPortClosed(t, ep.Port)
}

func TestCloseStopsMultipleStubbornSessionsConcurrently(t *testing.T) {
	m, _ := descendantManager(t, "stubborn")
	var ports []int
	for i := 0; i < 4; i++ {
		p := ssmProfile()
		p.ID = fmt.Sprintf("p%d", i)
		ep, err := m.ResolveEndpoint(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		ports = append(ports, ep.Port)
	}
	started := time.Now()
	m.Close()
	if elapsed := time.Since(started); elapsed > 2500*time.Millisecond {
		t.Errorf("shutdown took %s; must fit the desktop engine's 3-second grace period", elapsed)
	}
	for _, port := range ports {
		assertPortClosed(t, port)
	}
}
