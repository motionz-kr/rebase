package discovery

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var knownDatabasePorts = []int{1433, 3306, 5432, 6379, 27017}

type dockerContainer struct {
	Name  string `json:"Names"`
	Image string `json:"Image"`
	Ports string `json:"Ports"`
}

type LocalDatabaseDiscovery struct {
	probe      func(context.Context, int) bool
	listDocker func(context.Context) ([]dockerContainer, string)
}

func NewLocalDatabaseDiscovery() *LocalDatabaseDiscovery {
	return &LocalDatabaseDiscovery{probe: probeLoopbackPort, listDocker: listLocalDockerContainers}
}

func (d *LocalDatabaseDiscovery) Discover(ctx context.Context) (domain.DatabaseDiscoveryResult, error) {
	result := domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{}, DockerStatus: domain.DockerDiscoverySkipped}
	for _, port := range knownDatabasePorts {
		if err := ctx.Err(); err != nil {
			return domain.DatabaseDiscoveryResult{}, err
		}
		driver, ok := driverForPort(port)
		if ok && d.probe(ctx, port) {
			result.Candidates = append(result.Candidates, newCandidate(driver, port, "local", ""))
		}
	}

	containers, status := d.listDocker(ctx)
	result.DockerStatus = status
	result.Candidates = append(result.Candidates, parseDockerContainers(containers)...)
	return result, nil
}

func probeLoopbackPort(ctx context.Context, port int) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 180*time.Millisecond)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(probeCtx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func listLocalDockerContainers(ctx context.Context) ([]dockerContainer, string) {
	endpoint, err := activeDockerEndpoint(ctx)
	if err != nil {
		return nil, domain.DockerDiscoverySkipped
	}
	if !isLocalDockerEndpoint(endpoint) {
		return nil, domain.DockerDiscoveryRemote
	}

	commandCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, "docker", "--host", endpoint, "ps", "--format", "{{json .}}")
	cmd.Env = dockerCommandEnv()
	output, err := cmd.Output()
	if err != nil {
		return nil, domain.DockerDiscoverySkipped
	}

	var containers []dockerContainer
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		var container dockerContainer
		if json.Unmarshal(scanner.Bytes(), &container) == nil && container.Ports != "" {
			containers = append(containers, container)
		}
	}
	return containers, domain.DockerDiscoveryAvailable
}

func activeDockerEndpoint(ctx context.Context) (string, error) {
	if contextName := strings.TrimSpace(os.Getenv("DOCKER_CONTEXT")); contextName != "" {
		endpoint, err := inspectDockerContext(ctx, contextName)
		if err != nil {
			return "", err
		}
		if dockerHost := strings.TrimSpace(os.Getenv("DOCKER_HOST")); dockerHost != "" && !isLocalDockerEndpoint(dockerHost) {
			return dockerHost, nil
		}
		return endpoint, nil
	}
	if endpoint := strings.TrimSpace(os.Getenv("DOCKER_HOST")); endpoint != "" {
		return endpoint, nil
	}

	commandCtx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	defer cancel()
	show := exec.CommandContext(commandCtx, "docker", "context", "show")
	nameBytes, err := show.Output()
	if err != nil {
		return "", err
	}
	return inspectDockerContext(commandCtx, strings.TrimSpace(string(nameBytes)))
}

func inspectDockerContext(ctx context.Context, name string) (string, error) {
	if name == "" {
		return "", errors.New("Docker context name is empty")
	}
	commandCtx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, "docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}", name)
	cmd.Env = dockerCommandEnv()
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	var endpoint string
	if err := json.Unmarshal(output, &endpoint); err != nil {
		return "", err
	}
	return endpoint, nil
}

func dockerCommandEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "DOCKER_HOST" || key == "DOCKER_CONTEXT" {
			continue
		}
		env = append(env, entry)
	}
	return env
}

func isLocalDockerEndpoint(endpoint string) bool {
	if strings.HasPrefix(endpoint, "unix://") {
		return true
	}
	if strings.EqualFold(endpoint, "npipe:////./pipe/docker_engine") {
		return true
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "tcp" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func parseDockerContainers(containers []dockerContainer) []domain.DiscoveredDatabase {
	var candidates []domain.DiscoveredDatabase
	seen := make(map[string]struct{})
	for _, container := range containers {
		name := strings.TrimPrefix(container.Name, "/")
		for _, mapping := range strings.Split(container.Ports, ",") {
			left, right, ok := strings.Cut(strings.TrimSpace(mapping), "->")
			if !ok || !strings.HasSuffix(right, "/tcp") {
				continue
			}
			hostPort, err := strconv.Atoi(left[strings.LastIndex(left, ":")+1:])
			if err != nil || hostPort < 1 || hostPort > 65535 {
				continue
			}
			containerPortText := strings.TrimSuffix(right, "/tcp")
			containerPortText = containerPortText[strings.LastIndex(containerPortText, ":")+1:]
			containerPort, err := strconv.Atoi(containerPortText)
			if err != nil {
				continue
			}
			driver, ok := driverForPort(containerPort)
			if !ok {
				continue
			}
			candidate := newCandidate(driver, hostPort, "docker", name)
			if _, exists := seen[candidate.ID]; exists {
				continue
			}
			seen[candidate.ID] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func driverForPort(port int) (string, bool) {
	switch port {
	case 1433:
		return "sqlserver", true
	case 3306:
		return "mysql", true
	case 5432:
		return "postgres", true
	case 6379:
		return "redis", true
	case 27017:
		return "mongodb", true
	default:
		return "", false
	}
}

func newCandidate(driver string, port int, source, sourceName string) domain.DiscoveredDatabase {
	host := "127.0.0.1"
	return domain.DiscoveredDatabase{
		ID:         domain.CandidateID(driver, host, port),
		Driver:     driver,
		Host:       host,
		Port:       port,
		Source:     source,
		SourceName: sourceName,
	}
}
