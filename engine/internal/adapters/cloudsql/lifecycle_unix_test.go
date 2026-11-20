//go:build !windows

package cloudsql

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

const failLine = `proxy server error: failed to get instance: refresh error: failed to get instance metadata (connection name = "x:y:z"): googleapi: Error 400: Project specified in the request is invalid., errorInvalidProject secret-e2e-token`

// Re-executes the test binary as a fake cloud-sql-proxy printing the real log lines.
// Modes: ok, fail, never (hang before readiness), noport (ready text, no listener),
// ignoreterm (ok, but ignores SIGTERM). In ok modes it exits once REBASE_CSQL_EXIT exists.
func TestCloudSQLProxyHelper(t *testing.T) {
	mode := os.Getenv("REBASE_CSQL_MODE")
	if mode == "" {
		return
	}
	var port string
	args := os.Args
	for i, a := range args {
		if a == "--port" && i+1 < len(args) {
			port = args[i+1]
		}
	}
	if dir := os.Getenv("REBASE_CSQL_DUMP"); dir != "" {
		_ = os.WriteFile(filepath.Join(dir, strconv.Itoa(os.Getpid())+".pid"), []byte(strings.Join(args[1:], "\n")+"\nPATH="+os.Getenv("PATH")+"\n"), 0600)
	}
	fmt.Println("Authorizing with gcloud user credentials")
	if mode == "fail" {
		fmt.Println("Connection test started")
		fmt.Fprintln(os.Stderr, "Connection test failed")
		fmt.Fprintln(os.Stderr, failLine)
		os.Exit(1)
	}
	if mode == "ignoreterm" {
		signal.Ignore(syscall.SIGTERM)
	}
	var ln net.Listener
	if mode != "noport" && mode != "never" {
		var err error
		if ln, err = net.Listen("tcp", "127.0.0.1:"+port); err != nil {
			os.Exit(1)
		}
	}
	fmt.Printf("[x:y:z] Listening on 127.0.0.1:%s\n", port)
	if mode == "never" {
		for {
			time.Sleep(time.Second)
		}
	}
	fmt.Println("The proxy has started successfully and is ready for new connections!")
	fmt.Println("Connection test started")
	fmt.Println("Connection test passed")
	if ln != nil {
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
			}
		}()
	}
	for {
		if _, err := os.Stat(os.Getenv("REBASE_CSQL_EXIT")); err == nil {
			os.Exit(0)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type harness struct {
	m        *Manager
	dump     string
	exitFile string
}

func newHarness(t *testing.T, mode string) *harness {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{m: NewManager(), dump: t.TempDir(), exitFile: filepath.Join(t.TempDir(), "exit")}
	h.m.findProxy = func(string) (string, error) { return exe, nil }
	h.m.gcloudDir = func() string { return "" }
	h.m.command = func(_ string, args ...string) *exec.Cmd {
		cmd := exec.Command(exe, append([]string{"-test.run=^TestCloudSQLProxyHelper$", "--"}, args...)...)
		cmd.Env = append(os.Environ(), "REBASE_CSQL_MODE="+mode, "REBASE_CSQL_DUMP="+h.dump, "REBASE_CSQL_EXIT="+h.exitFile)
		return cmd
	}
	t.Cleanup(func() {
		h.m.Close()
		for _, pid := range h.pids() {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})
	return h
}

func (h *harness) pids() []int {
	files, _ := filepath.Glob(filepath.Join(h.dump, "*.pid"))
	var pids []int
	for _, f := range files {
		pid, _ := strconv.Atoi(strings.TrimSuffix(filepath.Base(f), ".pid"))
		pids = append(pids, pid)
	}
	return pids
}

func (h *harness) waitPids(t *testing.T, n int) []int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p := h.pids(); len(p) >= n {
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d proxy processes, got %d", n, len(h.pids()))
	return nil
}

func assertGone(t *testing.T, pids ...int) {
	t.Helper()
	for _, pid := range pids {
		deadline := time.Now().Add(3 * time.Second)
		for syscall.Kill(pid, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("process %d still alive (orphan)", pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func assertPortClosed(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 50*time.Millisecond)
		if err != nil {
			return
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			t.Fatalf("port %d still open", port)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func profile(id string, cfg domain.GCPCloudSQLConfig) domain.ConnectionProfile {
	p := cloudProfile(cfg)
	p.ID = id
	return p
}

func defaultProfile() domain.ConnectionProfile {
	return profile("cvi", domain.GCPCloudSQLConfig{InstanceConnectionName: instance})
}

func ctx5(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestArgsAndEnvReachChild(t *testing.T) {
	h := newHarness(t, "ok")
	h.m.findProxy = func(explicit string) (string, error) {
		if explicit != "/custom/proxy" {
			t.Errorf("explicit path not passed: %q", explicit)
		}
		exe, _ := os.Executable()
		return exe, nil
	}
	gdir := t.TempDir()
	h.m.gcloudDir = func() string { return gdir }
	p := profile("cvi", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "adc", PrivateIP: true, ProxyPath: "/custom/proxy"})
	ep, err := h.m.ResolveEndpoint(ctx5(t), p)
	if err != nil {
		t.Fatal(err)
	}
	if ep.Host != "127.0.0.1" || ep.Port == 0 {
		t.Fatalf("endpoint %+v", ep)
	}
	pid := h.waitPids(t, 1)[0]
	data, _ := os.ReadFile(filepath.Join(h.dump, strconv.Itoa(pid)+".pid"))
	got := string(data)
	want, _ := proxyArgs(p, ep.Port)
	if !strings.Contains(got, strings.Join(want, "\n")) {
		t.Fatalf("argv mismatch:\n%s\nwant %v", got, want)
	}
	exe, _ := os.Executable()
	pathLine := ""
	for _, l := range strings.Split(got, "\n") {
		if strings.HasPrefix(l, "PATH=") {
			pathLine = l
		}
	}
	prefix := "PATH=" + filepath.Dir(exe) + string(os.PathListSeparator) + gdir + string(os.PathListSeparator)
	if !strings.HasPrefix(pathLine, prefix) || !strings.HasSuffix(pathLine, os.Getenv("PATH")) {
		t.Fatalf("PATH = %q, want prefix %q + original", pathLine, prefix)
	}
}

func TestGcloudDirSkippedWhenDuplicateOrEmpty(t *testing.T) {
	h := newHarness(t, "ok")
	exe, _ := os.Executable()
	h.m.gcloudDir = func() string { return filepath.Dir(exe) }
	if _, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile()); err != nil {
		t.Fatal(err)
	}
	pid := h.waitPids(t, 1)[0]
	data, _ := os.ReadFile(filepath.Join(h.dump, strconv.Itoa(pid)+".pid"))
	dir := filepath.Dir(exe)
	if strings.Contains(string(data), "PATH="+dir+string(os.PathListSeparator)+dir+string(os.PathListSeparator)) {
		t.Fatalf("duplicate dir in PATH: %s", data)
	}
}

func TestConcurrentCallsCoalesceToOneProcess(t *testing.T) {
	h := newHarness(t, "ok")
	var wg sync.WaitGroup
	ports := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ep, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
			if err != nil {
				t.Error(err)
				return
			}
			ports <- ep.Port
		}()
	}
	wg.Wait()
	close(ports)
	first := -1
	for p := range ports {
		if first == -1 {
			first = p
		} else if p != first {
			t.Fatalf("ports differ: %d vs %d", first, p)
		}
	}
	if n := len(h.pids()); n != 1 {
		t.Fatalf("started %d processes, want 1", n)
	}
}

func TestReusesLiveProxy(t *testing.T) {
	h := newHarness(t, "ok")
	a, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err != nil || a != b || len(h.pids()) != 1 {
		t.Fatalf("not reused: %v %+v %+v pids=%d", err, a, b, len(h.pids()))
	}
}

func TestRestartsAfterProxyExit(t *testing.T) {
	h := newHarness(t, "ok")
	if _, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile()); err != nil {
		t.Fatal(err)
	}
	first := h.waitPids(t, 1)
	h.m.mu.Lock()
	var s *session
	for _, e := range h.m.entries {
		s = e.session
	}
	h.m.mu.Unlock()
	if err := os.WriteFile(h.exitFile, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("proxy did not exit")
	}
	_ = os.Remove(h.exitFile)
	if _, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile()); err != nil {
		t.Fatal(err)
	}
	if n := len(h.waitPids(t, 2)); n != 2 {
		t.Fatalf("expected a second process, have %d", n)
	}
	assertGone(t, first...)
}

func TestStartupFailureIsMappedAndSanitized(t *testing.T) {
	h := newHarness(t, "fail")
	_, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err == nil {
		t.Fatal("must fail")
	}
	if err.Error() != startupError(failLine).Error() {
		t.Fatalf("got %q want %q", err, startupError(failLine))
	}
	if strings.Contains(err.Error(), "secret-e2e-token") || strings.Contains(err.Error(), "googleapi") {
		t.Fatalf("raw output leaked: %v", err)
	}
	assertGone(t, h.waitPids(t, 1)...)
	// A failed entry is replaced on the next call rather than cached forever.
	if _, err = h.m.ResolveEndpoint(ctx5(t), defaultProfile()); err == nil {
		t.Fatal("must fail again")
	}
	if n := len(h.waitPids(t, 2)); n != 2 {
		t.Fatalf("failed entry was cached: %d processes", n)
	}
}

func TestNeverReadyTimesOutAndCleansUp(t *testing.T) {
	h := newHarness(t, "never")
	h.m.startTimeout = 400 * time.Millisecond
	_, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err == nil || !strings.Contains(err.Error(), "Cloud SQL Proxy 준비 시간이 초과되었거나 취소되었습니다") {
		t.Fatalf("got %v", err)
	}
	assertGone(t, h.waitPids(t, 1)...)
}

func TestReadyWithoutOpenPortReportsPortError(t *testing.T) {
	h := newHarness(t, "noport")
	h.m.startTimeout = 600 * time.Millisecond
	_, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err == nil || err.Error() != "Cloud SQL: 로컬 프록시 포트를 열지 못했습니다" {
		t.Fatalf("got %v", err)
	}
	assertGone(t, h.waitPids(t, 1)...)
}

func TestCloseProfileDuringStartCancelsAndCleansUp(t *testing.T) {
	h := newHarness(t, "never")
	errc := make(chan error, 1)
	go func() { _, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile()); errc <- err }()
	pids := h.waitPids(t, 1)
	h.m.CloseProfile("cvi")
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ResolveEndpoint did not return after CloseProfile")
	}
	assertGone(t, pids...)
}

func TestCloseProfileIsolatesProfiles(t *testing.T) {
	h := newHarness(t, "ok")
	a, err := h.m.ResolveEndpoint(ctx5(t), profile("a", domain.GCPCloudSQLConfig{InstanceConnectionName: instance}))
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.m.ResolveEndpoint(ctx5(t), profile("b", domain.GCPCloudSQLConfig{InstanceConnectionName: instance}))
	if err != nil {
		t.Fatal(err)
	}
	if a.Port == b.Port {
		t.Fatal("profiles must have separate proxies")
	}
	h.m.CloseProfile("a")
	assertPortClosed(t, a.Port)
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", b.Port), time.Second)
	if err != nil {
		t.Fatalf("profile b was closed too: %v", err)
	}
	_ = conn.Close()
}

func TestCloseStopsAllAndRejectsNewCalls(t *testing.T) {
	h := newHarness(t, "ok")
	var ports []int
	for _, id := range []string{"a", "b", "c"} {
		ep, err := h.m.ResolveEndpoint(ctx5(t), profile(id, domain.GCPCloudSQLConfig{InstanceConnectionName: instance}))
		if err != nil {
			t.Fatal(err)
		}
		ports = append(ports, ep.Port)
	}
	pids := h.waitPids(t, 3)
	h.m.Close()
	for _, p := range ports {
		assertPortClosed(t, p)
	}
	assertGone(t, pids...)
	_, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err == nil || err.Error() != "Cloud SQL proxy manager is closed" {
		t.Fatalf("got %v", err)
	}
}

func TestSettingsChangeStartsNewProcess(t *testing.T) {
	h := newHarness(t, "ok")
	a, err := h.m.ResolveEndpoint(ctx5(t), defaultProfile())
	if err != nil {
		t.Fatal(err)
	}
	b, err := h.m.ResolveEndpoint(ctx5(t), profile("cvi", domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "adc"}))
	if err != nil {
		t.Fatal(err)
	}
	if a.Port == b.Port || len(h.pids()) != 2 {
		t.Fatalf("settings change must start a new proxy: %+v %+v pids=%d", a, b, len(h.pids()))
	}
}

func TestCloseEscalatesToSIGKILLWithinGracePeriod(t *testing.T) {
	h := newHarness(t, "ignoreterm")
	var ports []int
	for i := 0; i < 3; i++ {
		ep, err := h.m.ResolveEndpoint(ctx5(t), profile(fmt.Sprintf("p%d", i), domain.GCPCloudSQLConfig{InstanceConnectionName: instance}))
		if err != nil {
			t.Fatal(err)
		}
		ports = append(ports, ep.Port)
	}
	pids := h.waitPids(t, 3)
	started := time.Now()
	h.m.Close()
	if d := time.Since(started); d > 2500*time.Millisecond {
		t.Errorf("shutdown took %s; must fit the 3-second grace period", d)
	}
	for _, p := range ports {
		assertPortClosed(t, p)
	}
	assertGone(t, pids...)
}
