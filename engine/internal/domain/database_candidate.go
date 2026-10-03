package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
)

const (
	DockerDiscoveryAvailable = "available"
	DockerDiscoverySkipped   = "skipped"
	DockerDiscoveryRemote    = "remote_context"
)

// DiscoveredDatabase is a credential-free endpoint found on the local machine.
type DiscoveredDatabase struct {
	ID         string `json:"id"`
	Driver     string `json:"driver"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Source     string `json:"source"` // local | docker
	SourceName string `json:"sourceName,omitempty"`
}

type DatabaseDiscoveryResult struct {
	Candidates   []DiscoveredDatabase `json:"candidates"`
	DockerStatus string               `json:"dockerStatus"`
}

func CandidateID(driver, host string, port int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", driver, host, port)))
	return hex.EncodeToString(sum[:12])
}

func (c DiscoveredDatabase) Validate() error {
	if c.Driver != "mysql" && c.Driver != "postgres" && c.Driver != "redis" && c.Driver != "sqlserver" && c.Driver != "mongodb" {
		return fmt.Errorf("unsupported database driver: %s", c.Driver)
	}
	if c.ID == "" || c.ID != CandidateID(c.Driver, c.Host, c.Port) {
		return fmt.Errorf("invalid database candidate id")
	}
	if ip := net.ParseIP(c.Host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("database discovery only allows loopback hosts")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid database candidate port")
	}
	if c.Source != "local" && c.Source != "docker" {
		return fmt.Errorf("invalid database candidate source")
	}
	return nil
}
