package cloudsql

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/procgroup"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type entry struct {
	profileID string
	ready     chan struct{}
	cancel    context.CancelFunc
	session   *session
	err       error
}

type session struct {
	cmd      *exec.Cmd
	done     chan struct{}
	output   *proxyOutput
	endpoint ports.ConnectionEndpoint
	once     sync.Once
}

func (s *session) alive() bool {
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

func (s *session) stop() {
	s.once.Do(func() {
		procgroup.Terminate(s.cmd)
		select {
		case <-s.done:
		case <-time.After(time.Second):
		}
		// Always finish the process group, including descendants that ignore
		// SIGTERM and retain the output pipes.
		procgroup.Kill(s.cmd)
		select {
		case <-s.done:
		case <-time.After(time.Second):
		}
	})
}

var errStartCanceled = errors.New("Cloud SQL Proxy 준비 시간이 초과되었거나 취소되었습니다. gcloud 인증과 인스턴스 상태를 확인하세요")

const readyMarker = "Connection test passed"

// proxyOutput is bounded, concurrency-safe and never forwarded to stderr/stdout.
// Readiness is the connection test line, which can arrive split across writes.
type proxyOutput struct {
	mu    sync.Mutex
	text  string
	seen  bool
	ready chan struct{}
	once  sync.Once
}

func (o *proxyOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	o.text += string(p)
	// Detect before trimming so a marker followed by a flood is never lost.
	if strings.Contains(o.text, readyMarker) {
		o.seen = true
	}
	if len(o.text) > 16384 {
		o.text = o.text[len(o.text)-16384:]
	}
	ready := o.seen
	o.mu.Unlock()
	if ready {
		o.once.Do(func() { close(o.ready) })
	}
	return len(p), nil
}

func (o *proxyOutput) diagnostic() string { o.mu.Lock(); defer o.mu.Unlock(); return o.text }

type Manager struct {
	mu           sync.Mutex
	drain        sync.WaitGroup // owned shutdown work; Add only under mu
	entries      map[string]*entry
	closed       bool
	findProxy    func(string) (string, error)
	gcloudDir    func() string
	command      func(string, ...string) *exec.Cmd
	startTimeout time.Duration
}

func NewManager() *Manager {
	return &Manager{entries: make(map[string]*entry), findProxy: findProxy, gcloudDir: findGcloudDir, command: exec.Command, startTimeout: 30 * time.Second}
}

func tunnelKey(p domain.ConnectionProfile) string {
	cfg := p.GCPCloudSQL
	auth := cfg.AuthMode
	if auth == "" {
		auth = "gcloud"
	}
	return fmt.Sprintf("%q/%q/%q/%q/%t/%q", p.ID, cfg.InstanceConnectionName, auth, cfg.CredentialsFile, cfg.PrivateIP, cfg.ProxyPath)
}

func (m *Manager) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	if p.ConnectionMode != "gcp_cloudsql" {
		return ports.ConnectionEndpoint{}, errors.New("Cloud SQL connection mode is required")
	}
	if err := p.ValidateConnectionRoute(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	key := tunnelKey(p)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ports.ConnectionEndpoint{}, errors.New("Cloud SQL proxy manager is closed")
	}
	e := m.entries[key]
	var stale *session
	if e != nil {
		select {
		case <-e.ready:
			if e.err != nil || !e.session.alive() {
				delete(m.entries, key)
				stale = e.session
				e = nil
			}
		default:
		}
	}
	if e == nil {
		// The start must outlive this request: other callers may share it.
		startCtx, cancel := context.WithTimeout(context.Background(), m.startTimeout)
		e = &entry{profileID: p.ID, ready: make(chan struct{}), cancel: cancel}
		m.entries[key] = e
		go func() { defer cancel(); e.session, e.err = m.start(startCtx, p); close(e.ready) }()
	}
	if stale != nil {
		m.drain.Add(1)
	}
	m.mu.Unlock()
	if stale != nil {
		stale.stop()
		m.drain.Done()
	}
	select {
	case <-ctx.Done():
		return ports.ConnectionEndpoint{}, ctx.Err()
	case <-e.ready:
		if e.err != nil {
			return ports.ConnectionEndpoint{}, e.err
		}
		if !e.session.alive() {
			return ports.ConnectionEndpoint{}, errors.New("Cloud SQL Proxy 연결이 종료되었습니다. 다시 연결하세요")
		}
		return e.session.endpoint, nil
	}
}

func (m *Manager) start(ctx context.Context, p domain.ConnectionProfile) (*session, error) {
	proxyPath, err := m.findProxy(p.GCPCloudSQL.ProxyPath)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("Cloud SQL: 로컬 포트 할당 실패: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	args, err := proxyArgs(p, port)
	if err != nil {
		return nil, err
	}
	cmd := m.command(proxyPath, args...)
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	// The proxy shells out to gcloud for --gcloud-auth; desktop launches have a minimal PATH.
	dirs := []string{filepath.Dir(proxyPath)}
	if g := m.gcloudDir(); g != "" && g != dirs[0] {
		dirs = append(dirs, g)
	}
	dirs = append(dirs, os.Getenv("PATH"))
	cmd.Env = append(cmd.Env, "PATH="+strings.Join(dirs, string(os.PathListSeparator)))
	procgroup.Configure(cmd)
	cmd.WaitDelay = time.Second
	output := &proxyOutput{ready: make(chan struct{})}
	cmd.Stdout = output
	cmd.Stderr = output
	if err = cmd.Start(); err != nil {
		return nil, errors.New("Cloud SQL: cloud-sql-proxy를 실행하지 못했습니다. 설치 경로와 실행 권한을 확인하세요")
	}
	s := &session{cmd: cmd, done: make(chan struct{}), output: output, endpoint: ports.ConnectionEndpoint{Host: "127.0.0.1", Port: port}}
	go func() {
		_ = cmd.Wait()
		close(s.done)
		// Clean up unexpected exits immediately, even if no more queries arrive.
		s.stop()
	}()
	select {
	case <-ctx.Done():
		s.stop()
		return nil, errStartCanceled
	case <-s.done:
		s.stop()
		return nil, startupError(output.diagnostic())
	case <-output.ready:
	}
	// The proxy may print readiness just before its listener accepts connections.
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		dialer := net.Dialer{Timeout: 200 * time.Millisecond}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(s.endpoint.Host, strconv.Itoa(port)))
		if err == nil {
			_ = conn.Close()
			if ctx.Err() != nil {
				s.stop()
				return nil, errStartCanceled
			}
			return s, nil
		}
		select {
		case <-ctx.Done():
			s.stop()
			return nil, errors.New("Cloud SQL: 로컬 프록시 포트를 열지 못했습니다")
		case <-s.done:
			s.stop()
			return nil, startupError(output.diagnostic())
		case <-ticker.C:
		}
	}
}

func (m *Manager) closeEntries(profileID string, all bool) {
	m.mu.Lock()
	var entries []*entry
	if all {
		m.closed = true
	}
	for key, e := range m.entries {
		if all || e.profileID == profileID {
			e.cancel()
			entries = append(entries, e)
			delete(m.entries, key)
		}
	}
	m.drain.Add(len(entries))
	m.mu.Unlock()
	// Wait outside the map lock and stop separate process trees concurrently so
	// shutdown has a fixed grace period independent of profile count.
	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func() {
			defer m.drain.Done()
			defer wg.Done()
			<-e.ready
			if e.session != nil {
				e.session.stop()
			}
		}()
	}
	wg.Wait()
	if all {
		// Also wait for drains owned by concurrent CloseProfile/Close calls.
		m.drain.Wait()
	}
}

func (m *Manager) CloseProfile(profileID string) { m.closeEntries(profileID, false) }
func (m *Manager) Close()                        { m.closeEntries("", true) }
