package cloudsql

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestProxyOutputDetectsReadinessSplitAcrossWrites(t *testing.T) {
	o := &proxyOutput{ready: make(chan struct{})}
	_, _ = o.Write([]byte("Connection test started\nConnection test pa"))
	select {
	case <-o.ready:
		t.Fatal("ready too early")
	default:
	}
	_, _ = o.Write([]byte("ssed\n"))
	select {
	case <-o.ready:
	default:
		t.Fatal("split readiness line not detected")
	}
}

func TestProxyOutputIsBounded(t *testing.T) {
	o := &proxyOutput{ready: make(chan struct{})}
	chunk := strings.Repeat("x", 4096)
	for i := 0; i < 20; i++ {
		_, _ = o.Write([]byte(chunk))
	}
	if n := len(o.diagnostic()); n > 16384 {
		t.Fatalf("output not bounded: %d", n)
	}
}

func TestTunnelKeyChangesWithSettings(t *testing.T) {
	base := domain.GCPCloudSQLConfig{InstanceConnectionName: instance}
	variants := []domain.GCPCloudSQLConfig{
		base,
		{InstanceConnectionName: "my-project:asia-northeast3:other-db"},
		{InstanceConnectionName: instance, AuthMode: "adc"},
		{InstanceConnectionName: instance, AuthMode: "credentials_file", CredentialsFile: "/k/a.json"},
		{InstanceConnectionName: instance, AuthMode: "credentials_file", CredentialsFile: "/k/b.json"},
		{InstanceConnectionName: instance, PrivateIP: true},
		{InstanceConnectionName: instance, ProxyPath: "/opt/proxy"},
	}
	seen := map[string]int{}
	for i, v := range variants {
		k := tunnelKey(cloudProfile(v))
		if j, dup := seen[k]; dup {
			t.Fatalf("variants %d and %d share key %s", j, i, k)
		}
		seen[k] = i
	}
	// "" and "gcloud" are the same default mode and must reuse one proxy.
	if tunnelKey(cloudProfile(base)) != tunnelKey(cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: instance, AuthMode: "gcloud"})) {
		t.Fatal("default auth mode aliases must share a key")
	}
	other := cloudProfile(base)
	other.ID = "other"
	if tunnelKey(other) == tunnelKey(cloudProfile(base)) {
		t.Fatal("profile ID must be part of the key")
	}
}

func TestResolveEndpointRejectsWrongModeAndInvalidRoute(t *testing.T) {
	m := NewManager()
	defer m.Close()
	p := cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: instance})
	p.ConnectionMode = "ssm"
	if _, err := m.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("wrong mode must fail")
	}
	if _, err := m.ResolveEndpoint(context.Background(), cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: "bad"})); err == nil {
		t.Fatal("invalid route must fail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.ResolveEndpoint(ctx, cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: instance})); err != context.Canceled {
		t.Fatalf("canceled ctx: %v", err)
	}
}

func TestMissingProxyReturnsCuratedError(t *testing.T) {
	m := NewManager()
	defer m.Close()
	m.findProxy = func(string) (string, error) { return "", errProxyMissing }
	m.command = func(string, ...string) *exec.Cmd { t.Fatal("must not launch"); return nil }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := m.ResolveEndpoint(ctx, cloudProfile(domain.GCPCloudSQLConfig{InstanceConnectionName: instance}))
	if err != errProxyMissing {
		t.Fatalf("got %v", err)
	}
}

var errProxyMissing = errors.New("Cloud SQL: cloud-sql-proxy를 찾을 수 없습니다")
