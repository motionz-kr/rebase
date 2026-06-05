package domain

import (
	"errors"
	"time"
)

type ConnectionProfile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Driver    string `json:"driver"` // mysql, postgres, redis, sqlite
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Database  string `json:"database"`
	Username  string `json:"username"`
	SecretRef string `json:"secretRef"`
	TLSMode   string `json:"tlsMode"` // none, prefer, require
	// ReadOnly is a general read-only intent for the connection; currently the
	// sqlite connector honors it (opens mode=ro). Other drivers ignore it today.
	ReadOnly bool `json:"readOnly"`
	// MCP exposure for external AI clients (off by default).
	McpEnabled      bool      `json:"mcpEnabled"`
	McpDataExposure string    `json:"mcpDataExposure"` // metadata|on_request|unrestricted (default metadata)
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func (p ConnectionProfile) Validate() error {
	if p.Name == "" {
		return errors.New("connection profile name is required")
	}
	if p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "redis" && p.Driver != "sqlite" {
		return errors.New("unsupported database driver: " + p.Driver)
	}
	// SQLite is a local file: the path lives in Database; host/port are unused.
	if p.Driver == "sqlite" {
		if p.Database == "" {
			return errors.New("database file path is required for sqlite")
		}
		return nil
	}
	if p.Host == "" {
		return errors.New("database host is required")
	}
	if p.Port <= 0 || p.Port > 65535 {
		return errors.New("invalid database port")
	}
	if (p.Driver == "mysql" || p.Driver == "postgres") && p.Database == "" {
		return errors.New("database name is required for relational databases")
	}
	return nil
}
