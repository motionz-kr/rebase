package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	sshlib "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func testKey(t *testing.T) (sshlib.Signer, []byte) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := sshlib.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

type testServer struct {
	listener  net.Listener
	hostKey   sshlib.Signer
	clientKey []byte
	mu        sync.Mutex
	clients   []*sshlib.ServerConn
}

type testIdentity struct {
	signer sshlib.Signer
	key    []byte
}

func newTestServer(t *testing.T, destination string, auth ...testIdentity) *testServer {
	t.Helper()
	host, _ := testKey(t)
	identity, key := testKey(t)
	if len(auth) > 0 {
		identity, key = auth[0].signer, auth[0].key
	}
	config := &sshlib.ServerConfig{PublicKeyCallback: func(c sshlib.ConnMetadata, k sshlib.PublicKey) (*sshlib.Permissions, error) {
		if c.User() == "ec2-user" && string(k.Marshal()) == string(identity.PublicKey().Marshal()) {
			return nil, nil
		}
		return nil, os.ErrPermission
	}}
	config.AddHostKey(host)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &testServer{listener: listener, hostKey: host, clientKey: key}
	t.Cleanup(func() {
		listener.Close()
		server.mu.Lock()
		defer server.mu.Unlock()
		for _, c := range server.clients {
			c.Close()
		}
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				client, channels, requests, err := sshlib.NewServerConn(conn, config)
				if err != nil {
					conn.Close()
					return
				}
				server.mu.Lock()
				server.clients = append(server.clients, client)
				server.mu.Unlock()
				go func() {
					for r := range requests {
						_ = r.Reply(true, nil)
					}
				}()
				for request := range channels {
					if request.ChannelType() != "direct-tcpip" {
						request.Reject(sshlib.UnknownChannelType, "unsupported")
						continue
					}
					var info struct {
						Host       string
						Port       uint32
						Origin     string
						OriginPort uint32
					}
					if sshlib.Unmarshal(request.ExtraData(), &info) != nil {
						request.Reject(sshlib.ConnectionFailed, "invalid")
						continue
					}
					address := net.JoinHostPort(info.Host, strconv.Itoa(int(info.Port)))
					if destination != "" {
						if info.Host != "db.e2e.invalid" {
							request.Reject(sshlib.ConnectionFailed, "unexpected host")
							continue
						}
						address = destination
					}
					upstream, err := net.DialTimeout("tcp", address, time.Second)
					if err != nil {
						request.Reject(sshlib.ConnectionFailed, "unreachable")
						continue
					}
					channel, requests, err := request.Accept()
					if err != nil {
						upstream.Close()
						continue
					}
					go sshlib.DiscardRequests(requests)
					go func() {
						defer upstream.Close()
						defer channel.Close()
						done := make(chan struct{})
						go func() { io.Copy(upstream, channel); upstream.Close(); close(done) }()
						io.Copy(channel, upstream)
						channel.Close()
						<-done
					}()
				}
			}()
		}
	}()
	return server
}
func (server *testServer) profile(t *testing.T, dir string) domain.ConnectionProfile {
	t.Helper()
	identity := filepath.Join(dir, "identity.pem")
	known := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(identity, server.clientKey, 0600); err != nil {
		t.Fatal(err)
	}
	line := knownhosts.Line([]string{knownhosts.Normalize(server.listener.Addr().String())}, server.hostKey.PublicKey()) + "\n"
	if err := os.WriteFile(known, []byte(line), 0600); err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(server.listener.Addr().String())
	number, _ := strconv.Atoi(port)
	return domain.ConnectionProfile{ID: "p", Name: "SSH", Driver: "mysql", Host: "127.0.0.1", Port: 1, Database: "app", ConnectionMode: "ssh", SSH: &domain.SSHConfig{Host: host, Port: number, Username: "ec2-user", IdentityFile: identity, KnownHostsFile: known}}
}
func TestSSHForwardReuseCleanup(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); io.Copy(conn, conn) }()
		}
	}()
	server := newTestServer(t, "")
	p := server.profile(t, t.TempDir())
	p.Port = echo.Addr().(*net.TCPAddr).Port
	manager := NewManager()
	defer manager.Close()
	ctx := context.Background()
	ep, err := manager.ResolveEndpoint(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			other, err := manager.ResolveEndpoint(ctx, p)
			if err != nil || other != ep {
				t.Errorf("not reused: %v %v", other, err)
			}
		}()
	}
	wg.Wait()
	local, err := net.Dial("tcp", net.JoinHostPort(ep.Host, strconv.Itoa(ep.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	local.SetDeadline(time.Now().Add(3 * time.Second))
	local.Write([]byte("hello"))
	buf := make([]byte, 5)
	if _, err = io.ReadFull(local, buf); err != nil || string(buf) != "hello" {
		t.Fatal(string(buf), err)
	}
	manager.CloseProfile(p.ID)
	if conn, err := net.DialTimeout("tcp", net.JoinHostPort(ep.Host, strconv.Itoa(ep.Port)), time.Second); err == nil {
		conn.Close()
		t.Fatal("listener survived profile cleanup")
	}
	if _, err = local.Read(buf); err == nil {
		t.Fatal("active socket survived cleanup")
	}
	next, err := manager.ResolveEndpoint(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if next.Port == 0 {
		t.Fatal(next)
	}
	manager.Close()
	if _, err = manager.ResolveEndpoint(ctx, p); err == nil {
		t.Fatal("closed manager accepted connection")
	}
}
func TestSSHRejectsUntrustedHostAndWrongIdentity(t *testing.T) {
	server := newTestServer(t, "")
	p := server.profile(t, t.TempDir())
	manager := NewManager()
	defer manager.Close()
	os.WriteFile(p.SSH.KnownHostsFile, []byte(""), 0600)
	if _, err := manager.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("unknown host accepted")
	}
	wrong, _ := testKey(t)
	os.WriteFile(p.SSH.KnownHostsFile, []byte(knownhosts.Line([]string{knownhosts.Normalize(server.listener.Addr().String())}, wrong.PublicKey())+"\n"), 0600)
	if _, err := manager.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("changed host accepted")
	}
	p = server.profile(t, t.TempDir())
	_, wrongIdentity := testKey(t)
	os.WriteFile(p.SSH.IdentityFile, wrongIdentity, 0600)
	if _, err := manager.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("wrong identity accepted")
	}
}
func TestSSHCancelStartup(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	server := newTestServer(t, "")
	p := server.profile(t, t.TempDir())
	p.SSH.Port = listener.Addr().(*net.TCPAddr).Port
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	manager := NewManager()
	defer manager.Close()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, err := manager.ResolveEndpoint(ctx, p); result <- err }()
	var conn net.Conn
	select {
	case conn = <-accepted:
		defer conn.Close()
	case <-time.After(3 * time.Second):
		t.Fatal("no connection")
	}
	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("canceled request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation blocked")
	}
	done := make(chan struct{})
	go func() { manager.CloseProfile(p.ID); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("startup cleanup blocked")
	}
}

// This real SSH server is also used by isolated Electron E2E; it only forwards
// the synthetic DB hostname to the explicitly supplied local test DB.
func TestSSHServerHelper(t *testing.T) {
	if os.Getenv("REBASE_SSH_HELPER") != "1" {
		t.Skip("E2E helper only")
	}
	server := newTestServer(t, os.Getenv("REBASE_SSH_DESTINATION"))
	p := server.profile(t, os.Getenv("REBASE_SSH_DIR"))
	json.NewEncoder(os.Stdout).Encode(p.SSH)
	io.Copy(io.Discard, os.Stdin)
}

func TestSSHFileErrors(t *testing.T) {
	server := newTestServer(t, "")
	cases := map[string]struct {
		data    []byte
		message string
	}{
		"invalid key": {[]byte("not-a-private-key-secret-marker"), "PEM"},
		"empty key":   {nil, "PEM"},
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := sshlib.MarshalPrivateKeyWithPassphrase(private, "", []byte("test-only"))
	if err != nil {
		t.Fatal(err)
	}
	cases["encrypted key"] = struct {
		data    []byte
		message string
	}{pem.EncodeToMemory(encrypted), "암호화된 개인 키"}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			p := server.profile(t, t.TempDir())
			if err := os.WriteFile(p.SSH.IdentityFile, test.data, 0600); err != nil {
				t.Fatal(err)
			}
			m := NewManager()
			defer m.Close()
			_, err := m.ResolveEndpoint(context.Background(), p)
			if err == nil || !strings.Contains(err.Error(), test.message) || strings.Contains(err.Error(), "secret-marker") {
				t.Fatal(err)
			}
		})
	}
}

func TestSSHConcurrentStartupAndRemoteDisconnect(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	server := newTestServer(t, "")
	p := server.profile(t, t.TempDir())
	p.Port = echo.Addr().(*net.TCPAddr).Port
	manager := NewManager()
	defer manager.Close()
	endpoints := make(chan ports.ConnectionEndpoint, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ep, err := manager.ResolveEndpoint(context.Background(), p)
			if err != nil {
				t.Error(err)
				return
			}
			endpoints <- ep
		}()
	}
	wg.Wait()
	close(endpoints)
	var endpoint ports.ConnectionEndpoint
	for ep := range endpoints {
		if endpoint.Port == 0 {
			endpoint = ep
		}
		if ep != endpoint {
			t.Fatalf("startup created multiple tunnels: %v %v", ep, endpoint)
		}
	}
	server.mu.Lock()
	clients := append([]*sshlib.ServerConn(nil), server.clients...)
	server.mu.Unlock()
	if len(clients) != 1 {
		t.Fatalf("created %d SSH clients", len(clients))
	}
	clients[0].Close()
	timeout := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port)), 100*time.Millisecond)
		if err != nil {
			break
		}
		conn.Close()
		select {
		case <-timeout:
			t.Fatal("remote disconnect left local listener open")
		case <-ticker.C:
		}
	}
	if _, err := manager.ResolveEndpoint(context.Background(), p); err != nil {
		t.Fatalf("reconnection failed: %v", err)
	}
}
