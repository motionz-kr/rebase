package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net"
	"testing"

	sshlib "golang.org/x/crypto/ssh"
)

func TestSSHPEMAndOpenSSHAuthentication(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			conn, err := target.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rsaSigner, err := sshlib.NewSignerFromKey(rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	_, edKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edSigner, err := sshlib.NewSignerFromKey(edKey)
	if err != nil {
		t.Fatal(err)
	}
	openSSH, err := sshlib.MarshalPrivateKey(edKey, "")
	if err != nil {
		t.Fatal(err)
	}
	formats := map[string]testIdentity{
		"RSA PEM (EC2)": {rsaSigner, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)})},
		"OpenSSH":       {edSigner, pem.EncodeToMemory(openSSH)},
	}
	for name, identity := range formats {
		t.Run(name, func(t *testing.T) {
			server := newTestServer(t, "", identity)
			profile := server.profile(t, t.TempDir())
			profile.Port = target.Addr().(*net.TCPAddr).Port
			manager := NewManager()
			defer manager.Close()
			if _, err := manager.ResolveEndpoint(context.Background(), profile); err != nil {
				t.Fatal(err)
			}
		})
	}
}
