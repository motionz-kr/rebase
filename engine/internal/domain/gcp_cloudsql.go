package domain

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

// GCPCloudSQLConfig references a Cloud SQL instance reached through
// cloud-sql-proxy. It holds file paths only, never key contents or tokens.
type GCPCloudSQLConfig struct {
	InstanceConnectionName string `json:"instanceConnectionName"`
	AuthMode               string `json:"authMode,omitempty"` // empty/gcloud, adc, credentials_file
	CredentialsFile        string `json:"credentialsFile,omitempty"`
	PrivateIP              bool   `json:"privateIp,omitempty"`
	ProxyPath              string `json:"proxyPath,omitempty"`
}

var gcpInstanceConnectionName = regexp.MustCompile(`^([a-z][a-z0-9.\-]*[a-z0-9]:)?[a-z][a-z0-9\-]{4,28}[a-z0-9]:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9\-]{0,97}$`)

// UsesProxyManagedEndpoint reports whether the destination host/port are owned
// by the tunnel (SSM document or Cloud SQL proxy) rather than the profile.
func (p ConnectionProfile) UsesProxyManagedEndpoint() bool {
	return p.SSMUsesDocumentDestination() || p.ConnectionMode == "gcp_cloudsql"
}

func (p ConnectionProfile) validateGCPCloudSQLRoute() error {
	if p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "sqlserver" {
		return errors.New("Cloud SQL connections support MySQL, PostgreSQL and SQL Server")
	}
	c := p.GCPCloudSQL
	if c == nil || !gcpInstanceConnectionName.MatchString(c.InstanceConnectionName) {
		return errors.New("Cloud SQL requires an instance connection name (project:region:instance)")
	}
	switch c.AuthMode {
	case "", "gcloud", "adc":
	case "credentials_file":
		f := c.CredentialsFile
		if !filepath.IsAbs(f) || strings.ContainsAny(f, "\r\n\x00") || strings.HasPrefix(f, "-") {
			return errors.New("Cloud SQL: absolute service account key file path is required")
		}
	default:
		return errors.New("unsupported Cloud SQL auth mode")
	}
	if c.ProxyPath != "" && (!filepath.IsAbs(c.ProxyPath) || strings.ContainsAny(c.ProxyPath, "\r\n\x00")) {
		return errors.New("Cloud SQL: cloud-sql-proxy path must be absolute")
	}
	if p.TLSMode != "" && p.TLSMode != "none" && p.TLSMode != "prefer" {
		return errors.New("Cloud SQL Proxy encrypts the connection; set TLS to none")
	}
	return nil
}
