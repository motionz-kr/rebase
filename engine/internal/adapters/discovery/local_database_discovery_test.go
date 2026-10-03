package discovery

import (
	"context"
	"testing"
)

func TestLocalDatabaseDiscoveryFindsKnownLoopbackPort(t *testing.T) {
	d := LocalDatabaseDiscovery{
		probe:      func(_ context.Context, port int) bool { return port == 3306 },
		listDocker: func(context.Context) ([]dockerContainer, string) { return nil, "skipped" },
	}

	result, err := d.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(result.Candidates) != 1 {
		t.Fatalf("candidate count = %d, want 1", len(result.Candidates))
	}
	got := result.Candidates[0]
	if got.Driver != "mysql" || got.Host != "127.0.0.1" || got.Port != 3306 || got.Source != "local" {
		t.Fatalf("candidate = %#v", got)
	}
}

func TestParseDockerContainersUsesPublishedKnownDatabasePorts(t *testing.T) {
	containers := []dockerContainer{
		{Name: "/test-postgres", Image: "postgres:16", Ports: "0.0.0.0:5544->5432/tcp, :::5544->5432/tcp"},
		{Name: "unpublished", Image: "mysql:8", Ports: "3306/tcp"},
		{Name: "other", Image: "nginx:latest", Ports: "0.0.0.0:8080->80/tcp"},
		{Name: "local-only", Image: "redis:7", Ports: "127.0.0.1:6381->6379/tcp"},
	}

	got := parseDockerContainers(containers)
	if len(got) != 2 {
		t.Fatalf("candidate count = %d, want 2: %#v", len(got), got)
	}
	if got[0].Driver != "postgres" || got[0].Port != 5544 || got[0].SourceName != "test-postgres" {
		t.Errorf("first candidate = %#v", got[0])
	}
	if got[1].Driver != "redis" || got[1].Port != 6381 || got[1].SourceName != "local-only" {
		t.Errorf("second candidate = %#v", got[1])
	}
}

func TestIsLocalDockerEndpoint(t *testing.T) {
	for _, endpoint := range []string{"unix:///var/run/docker.sock", "unix:///Users/test/.docker/run/docker.sock", "npipe:////./pipe/docker_engine", "tcp://127.0.0.1:2375", "tcp://localhost:2375"} {
		if !isLocalDockerEndpoint(endpoint) {
			t.Errorf("isLocalDockerEndpoint(%q) = false", endpoint)
		}
	}
	for _, endpoint := range []string{"ssh://user@builder", "tcp://10.0.0.3:2375", "https://docker.example.com"} {
		if isLocalDockerEndpoint(endpoint) {
			t.Errorf("isLocalDockerEndpoint(%q) = true", endpoint)
		}
	}
}
