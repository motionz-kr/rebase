// Package ssh owns verified SSH connections and loopback forwarding listeners.
package ssh

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	sshlib "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type entry struct {
	profileID string
	ready     chan struct{}
	cancel    context.CancelFunc
	session   *session
	err       error
}
type session struct {
	client   *sshlib.Client
	listener net.Listener
	endpoint ports.ConnectionEndpoint
	done     chan struct{}
	once     sync.Once
	mu       sync.Mutex
	closed   bool
	sockets  map[net.Conn]struct{}
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
		s.mu.Lock()
		s.closed = true
		_ = s.listener.Close()
		_ = s.client.Close()
		for socket := range s.sockets {
			_ = socket.Close()
		}
		s.mu.Unlock()
	})
}
func (s *session) forward(local net.Conn, destination string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		local.Close()
		return
	}
	s.sockets[local] = struct{}{}
	s.mu.Unlock()
	defer func() { local.Close(); s.mu.Lock(); delete(s.sockets, local); s.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	remote, err := s.client.DialContext(ctx, "tcp", destination)
	if err != nil {
		return
	}
	defer remote.Close()
	finished := make(chan struct{})
	go func() { _, _ = io.Copy(remote, local); remote.Close(); local.Close(); close(finished) }()
	_, _ = io.Copy(local, remote)
	local.Close()
	remote.Close()
	<-finished
}
func (s *session) serve(destination string) {
	go func() { _ = s.client.Wait(); close(s.done); s.stop() }()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
				finished := make(chan struct{})
				go func() {
					_, _, err := s.client.SendRequest("keepalive@openssh.com", true, nil)
					if err != nil {
						s.stop()
					}
					close(finished)
				}()
				select {
				case <-finished:
				case <-s.done:
					return
				case <-time.After(5 * time.Second):
					s.stop()
					return
				}
			}
		}
	}()
	go func() {
		for {
			local, err := s.listener.Accept()
			if err != nil {
				return
			}
			go s.forward(local, destination)
		}
	}()
}

type Manager struct {
	mu      sync.Mutex
	entries map[string]*entry
	closed  bool
}

func NewManager() *Manager { return &Manager{entries: map[string]*entry{}} }
func (m *Manager) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	if p.ConnectionMode != "ssh" {
		return ports.ConnectionEndpoint{}, errors.New("SSH connection mode is required")
	}
	if err := p.ValidateConnectionRoute(); err != nil {
		return ports.ConnectionEndpoint{}, err
	}
	raw, _ := json.Marshal(struct {
		ID, Host string
		Port     int
		SSH      *domain.SSHConfig
	}{p.ID, p.Host, p.Port, p.SSH})
	key := string(raw)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ports.ConnectionEndpoint{}, errors.New("SSH tunnel manager is closed")
	}
	e := m.entries[key]
	var stale *session
	if e != nil {
		select {
		case <-e.ready:
			if e.err != nil || !e.session.alive() {
				stale = e.session
				delete(m.entries, key)
				e = nil
			}
		default:
		}
	}
	if e == nil {
		startCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		e = &entry{profileID: p.ID, ready: make(chan struct{}), cancel: cancel}
		m.entries[key] = e
		// Snapshot references before asynchronous startup; callers may edit their form.
		route := p
		config := *p.SSH
		route.SSH = &config
		go func() { defer cancel(); e.session, e.err = start(startCtx, route); close(e.ready) }()
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
			return ports.ConnectionEndpoint{}, errors.New("SSH 터널 연결이 종료되었습니다. 다시 연결하세요")
		}
		return e.session.endpoint, nil
	}
}
func expandPath(path string) (string, error) {
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}
func start(ctx context.Context, p domain.ConnectionProfile) (*session, error) {
	identity, err := expandPath(p.SSH.IdentityFile)
	if err != nil {
		return nil, errors.New("SSH: 키 파일 경로를 확인하세요")
	}
	info, err := os.Stat(identity)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return nil, errors.New("SSH: 개인 키 파일을 읽을 수 없습니다. 일반 키 파일을 선택하세요")
	}
	file, err := os.Open(identity)
	if err != nil {
		return nil, errors.New("SSH: 개인 키 파일을 읽을 수 없습니다. 경로와 권한을 확인하세요")
	}
	key, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	file.Close()
	if err != nil || len(key) > 1024*1024 {
		return nil, errors.New("SSH: 개인 키 파일을 읽을 수 없습니다")
	}
	signer, err := sshlib.ParsePrivateKey(key)
	if err != nil {
		var encrypted *sshlib.PassphraseMissingError
		if errors.As(err, &encrypted) {
			return nil, errors.New("SSH: 암호화된 개인 키는 아직 지원하지 않습니다. 암호가 없는 전용 키 파일을 선택하세요")
		}
		return nil, errors.New("SSH: 지원되는 PEM 또는 OpenSSH 개인 키 파일을 선택하세요")
	}
	knownPath := p.SSH.KnownHostsFile
	if knownPath == "" {
		knownPath = "~/.ssh/known_hosts"
	}
	knownPath, err = expandPath(knownPath)
	if err != nil {
		return nil, errors.New("SSH: known_hosts 경로를 확인하세요")
	}
	knownInfo, err := os.Stat(knownPath)
	if err != nil || !knownInfo.Mode().IsRegular() {
		return nil, errors.New("SSH: known_hosts 파일을 읽을 수 없습니다. 일반 파일을 선택하세요")
	}
	verify, err := knownhosts.New(knownPath)
	if err != nil {
		return nil, errors.New("SSH: known_hosts 파일을 읽을 수 없습니다. 신뢰할 수 있는 호스트 키를 먼저 등록하세요")
	}
	address := net.JoinHostPort(p.SSH.Host, strconv.Itoa(p.SSH.Port))
	hostKeyFailed := false
	config := &sshlib.ClientConfig{User: p.SSH.Username, Auth: []sshlib.AuthMethod{sshlib.PublicKeys(signer)}, HostKeyCallback: func(host string, remote net.Addr, key sshlib.PublicKey) error {
		err := verify(host, remote, key)
		if err != nil {
			hostKeyFailed = true
		}
		return err
	}}
	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("SSH: bastion에 연결할 수 없습니다. 주소·포트·네트워크를 확인하세요")
	}
	// SSH handshake APIs do not accept context; close the transport on cancellation.
	cancelHandshake := context.AfterFunc(ctx, func() { conn.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	clientConn, channels, requests, err := sshlib.NewClientConn(conn, address, config)
	cancelHandshake()
	if err != nil || ctx.Err() != nil {
		conn.Close()
		if hostKeyFailed {
			return nil, errors.New("SSH: bastion 호스트 키가 등록되지 않았거나 변경되었습니다. known_hosts를 확인하세요")
		}
		if ctx.Err() != nil {
			return nil, errors.New("SSH: 연결 준비 시간이 초과되었거나 취소되었습니다")
		}
		return nil, errors.New("SSH: 인증 또는 연결 협상에 실패했습니다. 사용자·개인 키·서버 설정을 확인하세요")
	}
	_ = conn.SetDeadline(time.Time{})
	client := sshlib.NewClient(clientConn, channels, requests)
	destination := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
	probe, err := client.DialContext(ctx, "tcp", destination)
	if err != nil {
		client.Close()
		return nil, errors.New("SSH: bastion에서 DB에 접근할 수 없습니다. DB 주소·포트·포워딩 권한을 확인하세요")
	}
	probe.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		client.Close()
		return nil, errors.New("SSH: 로컬 포트를 할당하지 못했습니다")
	}
	if ctx.Err() != nil {
		listener.Close()
		client.Close()
		return nil, ctx.Err()
	}
	s := &session{client: client, listener: listener, endpoint: ports.ConnectionEndpoint{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port}, done: make(chan struct{}), sockets: map[net.Conn]struct{}{}}
	s.serve(destination)
	return s, nil
}
func (m *Manager) closeEntries(id string, all bool) {
	m.mu.Lock()
	var entries []*entry
	if all {
		m.closed = true
	}
	for key, e := range m.entries {
		if all || e.profileID == id {
			e.cancel()
			entries = append(entries, e)
			delete(m.entries, key)
		}
	}
	m.mu.Unlock()
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
func (m *Manager) CloseProfile(id string) { m.closeEntries(id, false) }
func (m *Manager) Close()                 { m.closeEntries("", true) }
