// Package ssm owns local AWS CLI / Session Manager process lifecycles.
package ssm

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
	cmd             *exec.Cmd
	done            chan struct{}
	output          *sessionOutput
	endpoint        ports.ConnectionEndpoint
	once            sync.Once
	terminateRemote func(string)
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
		terminateProcessTree(s.cmd)
		select {
		case <-s.done:
		case <-time.After(time.Second):
		}
		// The CLI can exit before its plugin. Always finish cleaning the process
		// group, including descendants that ignore SIGTERM and retain pipes.
		killProcessTree(s.cmd)
		select {
		case <-s.done:
		case <-time.After(time.Second):
		}
		// Killing the client only closes its channel; AWS may still retain an
		// active session. Output has drained now, including startup failures.
		if id := s.output.sessionID(); id != "" && s.terminateRemote != nil {
			s.terminateRemote(id)
		}
	})
}

// sessionOutput is bounded, concurrency-safe and never forwarded to stderr/stdout.
// Readiness must come from the plugin, not an unrelated listener occupying a port.
type sessionOutput struct {
	mu             sync.Mutex
	text           string
	ready          chan struct{}
	once           sync.Once
	ownedSessionID string
}

func (o *sessionOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	o.text += string(p)
	if o.ownedSessionID == "" {
		if match := sessionIDLine.FindStringSubmatch(o.text); match != nil {
			o.ownedSessionID = match[1]
		}
	}
	if len(o.text) > 16384 {
		o.text = o.text[len(o.text)-16384:]
	}
	ready := strings.Contains(o.text, "Waiting for connections...") || (strings.Contains(o.text, "Port ") && strings.Contains(o.text, " opened for sessionId "))
	o.mu.Unlock()
	if ready {
		o.once.Do(func() { close(o.ready) })
	}
	return len(p), nil
}
func (o *sessionOutput) diagnostic() string { o.mu.Lock(); defer o.mu.Unlock(); return o.text }

func (o *sessionOutput) sessionID() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.ownedSessionID
}

type Manager struct {
	mu               sync.Mutex
	entries          map[string]*entry
	closed           bool
	lookPath         func(string) (string, error)
	command          func(string, ...string) *exec.Cmd
	terminateCommand func(context.Context, string, ...string) *exec.Cmd
}

func NewManager() *Manager {
	return &Manager{entries: make(map[string]*entry), lookPath: findExecutable, command: exec.Command, terminateCommand: exec.CommandContext}
}

// findExecutable also handles desktop launch environments with a minimal PATH.
func findExecutable(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	dirs := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	for _, dir := range dirs {
		if path, err := exec.LookPath(filepath.Join(dir, name)); err == nil {
			return path, nil
		}
	}
	return "", exec.ErrNotFound
}
func tunnelKey(p domain.ConnectionProfile) string {
	return fmt.Sprintf("%q/%q/%d/%q/%q/%q/%q/%q", p.ID, p.Host, p.Port, p.SSM.Profile, p.SSM.Region, p.SSM.InstanceID, p.SSM.DocumentName, p.SSM.DestinationMode)
}

func (m *Manager) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	if p.ConnectionMode != "ssm" {
		return ports.ConnectionEndpoint{}, errors.New("SSM connection mode is required")
	}
	if err := p.ValidateConnectionRoute(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	key := tunnelKey(p)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ports.ConnectionEndpoint{}, errors.New("AWS SSM tunnel manager is closed")
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
		startCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		e = &entry{profileID: p.ID, ready: make(chan struct{}), cancel: cancel}
		m.entries[key] = e
		go func() { defer cancel(); e.session, e.err = m.start(startCtx, p); close(e.ready) }()
	}
	m.mu.Unlock()
	if stale != nil {
		stale.stop()
	}
	select {
	case <-ctx.Done():
		return ports.ConnectionEndpoint{}, ctx.Err()
	case <-e.ready:
		if e.err != nil {
			return ports.ConnectionEndpoint{}, e.err
		}
		if !e.session.alive() {
			return ports.ConnectionEndpoint{}, errors.New("AWS SSM 터널 연결이 종료되었습니다. 다시 연결하세요")
		}
		return e.session.endpoint, nil
	}
}

func (m *Manager) start(ctx context.Context, p domain.ConnectionProfile) (*session, error) {
	awsPath, err := m.lookPath("aws")
	if err != nil {
		return nil, errors.New("AWS SSM: AWS CLI를 설치하고 PATH를 확인하세요")
	}
	pluginPath, err := m.lookPath("session-manager-plugin")
	if err != nil {
		return nil, errors.New("AWS SSM: session-manager-plugin을 설치하고 PATH를 확인하세요")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("AWS SSM: 로컬 포트 할당 실패: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	args, err := startSessionArgs(p, port)
	if err != nil {
		return nil, err
	}
	cmd := m.command(awsPath, args...)
	// Preserve the credential chain and make the discovered plugin available to CLI.
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	cmd.Env = append(cmd.Env, "AWS_PAGER=", "AWS_CLI_AUTO_PROMPT=off", "PATH="+filepath.Dir(pluginPath)+string(os.PathListSeparator)+os.Getenv("PATH"))
	configureProcess(cmd)
	cmd.WaitDelay = time.Second
	output := &sessionOutput{ready: make(chan struct{})}
	cmd.Stdout = output
	cmd.Stderr = output
	if err = cmd.Start(); err != nil {
		return nil, errors.New("AWS SSM: AWS CLI를 실행하지 못했습니다. 설치 경로와 실행 권한을 확인하세요")
	}
	s := &session{cmd: cmd, done: make(chan struct{}), output: output, endpoint: ports.ConnectionEndpoint{Host: "127.0.0.1", Port: port}}
	// Snapshot the route and command factory: profile edits must never retarget
	// cleanup, and request cancellation must not cancel the cleanup API call.
	config, terminateCommand := *p.SSM, m.terminateCommand
	s.terminateRemote = func(id string) { terminateRemoteSession(terminateCommand, awsPath, config, id) }
	go func() {
		_ = cmd.Wait()
		close(s.done)
		// Clean up unexpected exits immediately, even if no more queries arrive.
		s.stop()
	}()
	select {
	case <-ctx.Done():
		s.stop()
		return nil, errors.New("AWS SSM 연결 준비 시간이 초과되었거나 취소되었습니다. AWS 인증과 EC2 상태를 확인하세요")
	case <-s.done:
		s.stop()
		return nil, startupError(output.diagnostic())
	case <-output.ready:
	}
	// A plugin may print readiness just before Listen starts accepting connections.
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		dialer := net.Dialer{Timeout: 200 * time.Millisecond}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(s.endpoint.Host, strconv.Itoa(port)))
		if err == nil {
			conn.Close()
			if ctx.Err() != nil {
				s.stop()
				return nil, ctx.Err()
			}
			return s, nil
		}
		select {
		case <-ctx.Done():
			s.stop()
			return nil, errors.New("AWS SSM: 로컬 터널 포트를 열지 못했습니다")
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
	m.mu.Unlock()
	// Engine shutdown has a fixed grace period independent of profile count.
	// Wait outside the map lock and stop separate process trees concurrently.
	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-e.ready
			if e.session != nil {
				e.session.stop()
			}
		}()
	}
	wg.Wait()
}
func (m *Manager) CloseProfile(profileID string) { m.closeEntries(profileID, false) }
func (m *Manager) Close()                        { m.closeEntries("", true) }
