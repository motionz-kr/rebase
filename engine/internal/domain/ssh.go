package domain

import (
	"errors"
	"strings"
)

// SSHConfig stores only user-selected file references, never private key contents.
type SSHConfig struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	IdentityFile   string `json:"identityFile"`
	KnownHostsFile string `json:"knownHostsFile,omitempty"`
}

func validSSHHost(host string) bool {
	return host != "" && !strings.HasPrefix(host, "-") && !strings.ContainsAny(host, " /\\\t\r\n\x00")
}
func (p ConnectionProfile) validateSSHRoute() error {
	if p.Driver != "mysql" && p.Driver != "postgres" {
		return errors.New("SSH connections support MySQL and PostgreSQL")
	}
	c := p.SSH
	if c == nil || !validSSHHost(c.Host) || c.Port <= 0 || c.Port > 65535 {
		return errors.New("SSH: bastion host and valid port are required")
	}
	if strings.TrimSpace(c.Username) == "" || strings.ContainsAny(c.Username, " \t\r\n\x00") {
		return errors.New("SSH: bastion username is required")
	}
	if strings.TrimSpace(c.IdentityFile) == "" || strings.ContainsAny(c.IdentityFile+c.KnownHostsFile, "\r\n\x00") {
		return errors.New("SSH: valid private key file path is required")
	}
	if !validSSHHost(p.Host) || p.Port <= 0 || p.Port > 65535 {
		return errors.New("SSH: destination DB host and valid port are required")
	}
	return nil
}
