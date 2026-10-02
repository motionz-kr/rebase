package ssm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// A real disposable subprocess exercises output/readiness, exit and cleanup.
func TestSSMProcessHelper(t *testing.T) {
	if os.Getenv("REBASE_SSM_HELPER") != "1" {
		return
	}
	if id := os.Getenv("REBASE_SSM_SESSION_ID"); id != "" {
		fmt.Printf("\nStarting session with SessionId: %s\n", id)
	}
	if os.Getenv("REBASE_SSM_HELPER_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "AccessDeniedException secret-token")
		os.Exit(1)
	}
	if gate := os.Getenv("REBASE_SSM_HELPER_GATE"); gate != "" {
		for {
			if _, err := os.Stat(gate); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	args := os.Args
	var port int
	for i, arg := range args {
		if arg == "--helper-port" {
			port, _ = strconv.Atoi(args[i+1])
		}
	}
	if os.Getenv("REBASE_SSM_HELPER_NO_LISTENER") == "1" {
		fmt.Println("Waiting for connections...")
		for {
			time.Sleep(time.Second)
		}
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		os.Exit(1)
	}
	if os.Getenv("REBASE_SSM_HELPER_NO_READY") != "1" {
		fmt.Println("Waiting for connections...")
	}
	for {
		c, e := ln.Accept()
		if e != nil {
			os.Exit(0)
		}
		c.Close()
	}
}
func helperManager(t *testing.T) *Manager {
	t.Helper()
	m := NewManager()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m.lookPath = func(string) (string, error) { return exe, nil }
	m.command = func(_ string, args ...string) *exec.Cmd {
		// Last parameter JSON carries the local port.
		var port string
		for _, arg := range args {
			if len(arg) > 0 && arg[0] == '{' {
				var p map[string][]string
				_ = json.Unmarshal([]byte(arg), &p)
				port = p["localPortNumber"][0]
			}
		}
		cmd := exec.Command(exe, "-test.run=^TestSSMProcessHelper$", "--", "--helper-port", port)
		cmd.Env = append(os.Environ(), "REBASE_SSM_HELPER=1")
		return cmd
	}
	t.Cleanup(m.Close)
	return m
}
func TestManagerCoalescesAndRestarts(t *testing.T) {
	m := helperManager(t)
	p := ssmProfile()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	results := make(chan ports.ConnectionEndpoint, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ep, err := m.ResolveEndpoint(ctx, p)
			if err != nil {
				t.Error(err)
				return
			}
			results <- ep
		}()
	}
	wg.Wait()
	close(results)
	var first ports.ConnectionEndpoint
	for ep := range results {
		if first.Port == 0 {
			first = ep
		}
		if ep != first {
			t.Fatalf("different endpoints: %v / %v", first, ep)
		}
	}
	if len(m.entries) != 1 {
		t.Fatal("concurrent requests must share a tunnel")
	}
	for _, e := range m.entries {
		_ = e.session.cmd.Process.Kill()
		<-e.session.done
	}
	ep, err := m.ResolveEndpoint(ctx, p)
	if err != nil || ep.Port == 0 {
		t.Fatal(ep, err)
	}
	m.CloseProfile(p.ID)
	if len(m.entries) != 0 {
		t.Fatal("profile close must remove tunnel")
	}
	c, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", ep.Host, ep.Port), time.Second)
	if err == nil {
		c.Close()
		t.Fatal("tunnel still listening after cleanup")
	}
	m.Close()
	if _, err = m.ResolveEndpoint(ctx, p); err == nil {
		t.Fatal("closed manager must refuse new sessions")
	}
}
func TestManagerMissingAWSAndCancellation(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.Close)
	m.lookPath = func(string) (string, error) { return "", exec.ErrNotFound }
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err == nil {
		t.Fatal("must report missing CLI")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.ResolveEndpoint(ctx, ssmProfile()); err != context.Canceled {
		t.Fatal(err)
	}
}
func TestManagerStartupFailureIsSanitized(t *testing.T) {
	m := helperManager(t)
	factory := m.command
	m.command = func(name string, args ...string) *exec.Cmd {
		cmd := factory(name, args...)
		cmd.Env = append(cmd.Env, "REBASE_SSM_HELPER_FAIL=1")
		return cmd
	}
	_, err := m.ResolveEndpoint(context.Background(), ssmProfile())
	if err == nil || !strings.Contains(err.Error(), "IAM") || strings.Contains(err.Error(), "secret-token") {
		t.Fatal(err)
	}
}

func TestStartupRequiresReadinessAndOpenPort(t *testing.T) {
	for _, mode := range []string{"REBASE_SSM_HELPER_NO_LISTENER", "REBASE_SSM_HELPER_NO_READY"} {
		t.Run(mode, func(t *testing.T) {
			m := helperManager(t)
			factory := m.command
			var cmd *exec.Cmd
			m.command = func(name string, args ...string) *exec.Cmd {
				cmd = factory(name, args...)
				cmd.Env = append(cmd.Env, mode+"=1")
				return cmd
			}
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			if s, err := m.start(ctx, ssmProfile()); err == nil || s != nil {
				t.Fatalf("unready tunnel returned: %v, %v", s, err)
			}
			if cmd.ProcessState == nil {
				t.Fatal("timed-out startup did not wait for child exit")
			}
		})
	}
}

func TestCloseCancelsPendingStartup(t *testing.T) {
	for _, closeProfile := range []bool{false, true} {
		t.Run(fmt.Sprintf("profile=%t", closeProfile), func(t *testing.T) {
			m := helperManager(t)
			factory, started := m.command, make(chan struct{})
			m.command = func(name string, args ...string) *exec.Cmd {
				cmd := factory(name, args...)
				cmd.Env = append(cmd.Env, "REBASE_SSM_HELPER_GATE="+filepath.Join(t.TempDir(), "unopened"))
				close(started)
				return cmd
			}
			result := make(chan error, 1)
			go func() { _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); result <- err }()
			select {
			case <-started:
			case <-time.After(2 * time.Second):
				t.Fatal("startup never began")
			}
			if closeProfile {
				m.CloseProfile(ssmProfile().ID)
			} else {
				m.Close()
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("closed startup returned a usable endpoint")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("pending startup was not cancelled")
			}
		})
	}
}

func TestCancelledWaiterDoesNotCancelSharedStartup(t *testing.T) {
	m := helperManager(t)
	factory, started := m.command, make(chan struct{})
	gate := filepath.Join(t.TempDir(), "open")
	m.command = func(name string, args ...string) *exec.Cmd {
		cmd := factory(name, args...)
		cmd.Env = append(cmd.Env, "REBASE_SSM_HELPER_GATE="+gate)
		close(started)
		return cmd
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := m.ResolveEndpoint(ctx, ssmProfile()); first <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("startup never began")
	}
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatal(err)
	}
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if ep, err := m.ResolveEndpoint(ctx, ssmProfile()); err != nil || ep.Port == 0 {
		t.Fatal(ep, err)
	}
}

func TestProfileIsolationAndStartupRetry(t *testing.T) {
	m := helperManager(t)
	factory := m.command
	m.command = func(name string, args ...string) *exec.Cmd {
		cmd := factory(name, args...)
		cmd.Env = append(cmd.Env, "REBASE_SSM_HELPER_FAIL=1")
		return cmd
	}
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err == nil {
		t.Fatal("failed startup must surface an error")
	}
	m.command = factory
	first, err := m.ResolveEndpoint(context.Background(), ssmProfile())
	if err != nil {
		t.Fatal(err)
	}
	p := ssmProfile()
	p.ID = "another-profile"
	second, err := m.ResolveEndpoint(context.Background(), p)
	if err != nil || first == second {
		t.Fatal(first, second, err)
	}
	m.CloseProfile(ssmProfile().ID)
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(second.Host, strconv.Itoa(second.Port)), time.Second)
	if err != nil {
		t.Fatal("closing one profile must leave the other live:", err)
	}
	_ = conn.Close()
}

func TestManagerChangedDocumentDoesNotReuseOldTunnel(t *testing.T) {
	m := helperManager(t)
	p := ssmProfile()
	first, err := m.ResolveEndpoint(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	p.SSM.DocumentName = "Revisit-RdsPortForwarding"
	second, err := m.ResolveEndpoint(context.Background(), p)
	if err != nil || first == second {
		t.Fatal("changed document reused old tunnel", first, second, err)
	}
	p.SSM.DestinationMode = "document"
	p.Host = ""
	p.Port = 0
	third, err := m.ResolveEndpoint(context.Background(), p)
	if err != nil || third == second {
		t.Fatal("changed destination mode reused old tunnel", second, third, err)
	}
	m.CloseProfile(p.ID)
	for _, ep := range []ports.ConnectionEndpoint{first, second, third} {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(ep.Host, strconv.Itoa(ep.Port)), time.Second)
		if err == nil {
			conn.Close()
			t.Fatal("document tunnel survived profile close", ep)
		}
	}
}

func TestSessionOutputChunkingAndBoundedDiagnostics(t *testing.T) {
	for _, marker := range []string{"Waiting for connections...", "Port 15432 opened for sessionId s."} {
		o := &sessionOutput{ready: make(chan struct{})}
		for _, ch := range marker {
			if _, err := o.Write([]byte(string(ch))); err != nil {
				t.Fatal(err)
			}
		}
		select {
		case <-o.ready:
		default:
			t.Fatal("chunked plugin output did not mark readiness")
		}
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); _, _ = o.Write([]byte(strings.Repeat("x", 32000))) }()
		}
		wg.Wait()
		if len(o.diagnostic()) > 16384 {
			t.Fatal("CLI diagnostics must remain bounded")
		}
	}
}

func TestFindExecutableWithMinimalDesktopPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX PATH and HOME fixture")
	}
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	const name = "rebase-test-cli"
	exe := filepath.Join(dir, name)
	if err := os.WriteFile(exe, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if got, err := findExecutable(name); err != nil || got != exe {
		t.Fatal(got, err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	local := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(local, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(exe, filepath.Join(local, name)); err != nil {
		t.Fatal(err)
	}
	if got, err := findExecutable(name); err != nil || got != filepath.Join(local, name) {
		t.Fatal(got, err)
	}
	if _, err := findExecutable("rebase-test-missing-cli"); !errors.Is(err, exec.ErrNotFound) {
		t.Fatal(err)
	}
}
