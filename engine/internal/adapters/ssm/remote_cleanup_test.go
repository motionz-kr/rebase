package ssm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSessionOutputRetainsOwnedSessionID(t *testing.T) {
	for _, line := range []string{
		"\nStarting session with SessionId: smlee-0123456789abcdef\n",
		"Starting session with SessionId: smlee-0123456789abcdef\r\n",
	} {
		o := &sessionOutput{ready: make(chan struct{})}
		for _, ch := range line[:len(line)-1] {
			_, _ = o.Write([]byte(string(ch)))
		}
		if got := o.sessionID(); got != "" {
			t.Fatalf("partial session ID accepted: %q", got)
		}
		_, _ = o.Write([]byte(line[len(line)-1:]))
		_, _ = o.Write([]byte(strings.Repeat("x", 20000)))
		_, _ = o.Write([]byte("\nStarting session with SessionId: unrelated-id\n"))
		if got := o.sessionID(); got != "smlee-0123456789abcdef" {
			t.Fatalf("owned session ID lost or replaced: %q", got)
		}
	}
	for _, value := range []string{"--option", "id with spaces", strings.Repeat("a", 97)} {
		o := &sessionOutput{ready: make(chan struct{})}
		_, _ = o.Write([]byte("Starting session with SessionId: " + value + "\n"))
		if got := o.sessionID(); got != "" {
			t.Fatalf("invalid session ID accepted: %q", got)
		}
	}
}

// A separate real process models the AWS API: stopping the tunnel alone never
// writes this ledger, so these tests detect remote sessions left behind.
func TestTerminateSessionHelper(t *testing.T) {
	if os.Getenv("REBASE_TERMINATE_HELPER") != "1" {
		return
	}
	data, _ := json.Marshal(os.Args[3:])
	f, err := os.OpenFile(os.Getenv("REBASE_TERMINATE_LOG"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(1)
	}
	_, _ = fmt.Fprintln(f, string(data))
	_ = f.Close()
	if os.Getenv("REBASE_TERMINATE_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "AccessDeniedException secret-cleanup-token")
		fmt.Fprintln(os.Stdout, "secret-cleanup-response")
		os.Exit(1)
	}
	if os.Getenv("REBASE_TERMINATE_HANG") == "1" {
		for {
			time.Sleep(time.Second)
		}
	}
	os.Exit(0)
}

func remoteCleanupManager(t *testing.T, mode string) (*Manager, func() [][]string) {
	t.Helper()
	m := helperManager(t)
	factory := m.command
	m.command = func(name string, args ...string) *exec.Cmd {
		cmd := factory(name, args...)
		cmd.Env = append(cmd.Env, "REBASE_SSM_SESSION_ID=smlee-owned-session")
		if mode != "" {
			cmd.Env = append(cmd.Env, mode+"=1")
		}
		return cmd
	}
	logPath := filepath.Join(t.TempDir(), "terminated.jsonl")
	exe, _ := os.Executable()
	m.terminateCommand = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		if name != exe {
			t.Errorf("cleanup changed AWS executable: %q", name)
		}
		cmd := exec.CommandContext(ctx, exe, append([]string{"-test.run=^TestTerminateSessionHelper$", "--"}, args...)...)
		cmd.Env = append(os.Environ(), "REBASE_TERMINATE_HELPER=1", "REBASE_TERMINATE_LOG="+logPath)
		return cmd
	}
	return m, func() [][]string {
		data, _ := os.ReadFile(logPath)
		var calls [][]string
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line == "" {
				continue
			}
			var args []string
			if err := json.Unmarshal([]byte(line), &args); err != nil {
				t.Fatal(err)
			}
			calls = append(calls, args)
		}
		return calls
	}
}

func TestCloseTerminatesOwnedRemoteSessionOnce(t *testing.T) {
	for _, profile := range []string{"production", ""} {
		t.Run("profile="+profile, func(t *testing.T) {
			m, calls := remoteCleanupManager(t, "")
			p := ssmProfile()
			p.SSM.Profile = profile
			if _, err := m.ResolveEndpoint(context.Background(), p); err != nil {
				t.Fatal(err)
			}
			// The cleanup must retain the original route even if the caller edits it.
			p.SSM.Region = "us-east-1"
			m.CloseProfile(p.ID)
			m.Close()
			want := []string{"ssm", "terminate-session", "--session-id", "smlee-owned-session", "--region", "ap-northeast-2"}
			if profile != "" {
				want = append(want, "--profile", profile)
			}
			if got := calls(); !reflect.DeepEqual(got, [][]string{want}) {
				t.Fatalf("remote cleanup: got %v want %v", got, want)
			}
		})
	}
}

func TestStartupFailureAndCancellationTerminateRemoteSession(t *testing.T) {
	for _, mode := range []string{"REBASE_SSM_HELPER_FAIL", "REBASE_SSM_HELPER_NO_READY"} {
		t.Run(mode, func(t *testing.T) {
			m, calls := remoteCleanupManager(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			if _, err := m.start(ctx, ssmProfile()); err == nil {
				t.Fatal("startup must fail")
			}
			if got := calls(); len(got) != 1 {
				t.Fatalf("startup leaked remote session: %v", got)
			}
		})
	}
}

func TestUnexpectedExitTerminatesRemoteSessionWithoutNextRequest(t *testing.T) {
	m, calls := remoteCleanupManager(t, "")
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err != nil {
		t.Fatal(err)
	}
	s := m.entries[tunnelKey(ssmProfile())].session
	_ = s.cmd.Process.Kill()
	deadline := time.Now().Add(3 * time.Second)
	for len(calls()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(calls()) != 1 {
		t.Fatal("exited tunnel leaked its remote session until another request")
	}
	m.Close()
	if len(calls()) != 1 {
		t.Fatal("remote cleanup repeated")
	}
}

func TestRemoteCleanupIsBoundedAndStillClosesLocalTunnel(t *testing.T) {
	m, calls := remoteCleanupManager(t, "")
	factory := m.terminateCommand
	m.terminateCommand = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmd := factory(ctx, name, args...)
		cmd.Env = append(cmd.Env, "REBASE_TERMINATE_HANG=1")
		return cmd
	}
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err != nil {
		t.Fatal(err)
	}
	s := m.entries[tunnelKey(ssmProfile())].session
	start := time.Now()
	m.Close()
	if time.Since(start) > 8*time.Second {
		t.Fatal("remote cleanup exceeded shutdown budget")
	}
	if s.alive() || len(calls()) != 1 {
		t.Fatal("cleanup failed to stop local process or attempt remote termination")
	}
}

func TestRemoteCleanupFailureIsReportedWithoutCLIOutput(t *testing.T) {
	m, calls := remoteCleanupManager(t, "")
	factory := m.terminateCommand
	m.terminateCommand = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmd := factory(ctx, name, args...)
		cmd.Env = append(cmd.Env, "REBASE_TERMINATE_FAIL=1")
		return cmd
	}
	var diagnostic bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&diagnostic)
	defer log.SetOutput(previous)
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err != nil {
		t.Fatal(err)
	}
	m.Close()
	if len(calls()) != 1 || !strings.Contains(diagnostic.String(), "ssm:TerminateSession") || strings.Contains(diagnostic.String(), "secret-cleanup") {
		t.Fatalf("missing or unsafe cleanup diagnostic: %q", diagnostic.String())
	}
}

func TestNoRemoteSessionIsGuessedWithoutAnID(t *testing.T) {
	m := helperManager(t)
	m.terminateCommand = func(context.Context, string, ...string) *exec.Cmd {
		t.Error("must never guess IDs or enumerate other sessions")
		return nil
	}
	if _, err := m.ResolveEndpoint(context.Background(), ssmProfile()); err != nil {
		t.Fatal(err)
	}
	m.Close()
}
