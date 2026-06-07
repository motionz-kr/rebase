package domain

import (
	"encoding/json"
	"errors"
	"strings"
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
	// SafeMode marks a connection as a production DB: risky statements are
	// hard-blocked and require explicit acknowledgement before they run.
	SafeMode bool `json:"safeMode"`
	// TenantColumns is a comma-separated list of tenant-scope key columns
	// (e.g. "hospitalId,tenantId"). Empty falls back to the default set.
	TenantColumns string `json:"tenantColumns"`
	// DomainBindings is a JSON object mapping semantic roles to actual column
	// names for this connection (e.g. {"tenant":"hospitalId"}). Used by task
	// templates to resolve {{role:NAME}} placeholders. Empty = no bindings.
	DomainBindings string `json:"domainBindings"`
	// DomainGlossary is a JSON array of table/column business-meaning entries
	// (see DomainEntry). Injected into the AI assistant's system prompt so it
	// interprets natural-language queries with domain context. Empty = none.
	DomainGlossary string `json:"domainGlossary"`
	// DomainNotes is free-form domain rules text (e.g. "always deletedAt IS
	// NULL", "scope by hospitalId"). Injected alongside the glossary.
	DomainNotes string `json:"domainNotes"`
	// ConnectionURI is an optional full connection string (e.g. for mongodb,
	// "mongodb+srv://..."). When set it takes precedence over host/port.
	ConnectionURI string `json:"connectionUri"`
	// MCP exposure for external AI clients (off by default).
	McpEnabled      bool      `json:"mcpEnabled"`
	McpDataExposure string    `json:"mcpDataExposure"` // metadata|on_request|unrestricted (default metadata)
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// DomainBindingMap parses DomainBindings JSON into a role→column map. Invalid or
// empty JSON yields an empty map (never nil-panics).
func (p ConnectionProfile) DomainBindingMap() map[string]string {
	out := map[string]string{}
	if strings.TrimSpace(p.DomainBindings) == "" {
		return out
	}
	_ = json.Unmarshal([]byte(p.DomainBindings), &out)
	return out
}

// TenantColumnList returns the configured tenant-scope columns, falling back to
// the default set ("hospitalId", "tenantId") when none are configured. Blank
// entries are dropped and surrounding whitespace trimmed.
func (p ConnectionProfile) TenantColumnList() []string {
	if strings.TrimSpace(p.TenantColumns) == "" {
		return []string{"hospitalId", "tenantId"}
	}
	var out []string
	for _, part := range strings.Split(p.TenantColumns, ",") {
		if t := strings.TrimSpace(part); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return []string{"hospitalId", "tenantId"}
	}
	return out
}

// DomainEntry is one table- or column-level business-meaning mapping.
type DomainEntry struct {
	Kind    string `json:"kind"`    // "table" | "column"
	Table   string `json:"table"`   // table name
	Column  string `json:"column"`  // column name (empty for table entries)
	Meaning string `json:"meaning"` // business meaning
}

// DomainGlossaryEntries parses DomainGlossary JSON into entries. Invalid or
// empty JSON yields an empty slice (never nil-panics, mirrors DomainBindingMap).
func (p ConnectionProfile) DomainGlossaryEntries() []DomainEntry {
	if strings.TrimSpace(p.DomainGlossary) == "" {
		return nil
	}
	var out []DomainEntry
	_ = json.Unmarshal([]byte(p.DomainGlossary), &out)
	return out
}

func (p ConnectionProfile) Validate() error {
	if p.Name == "" {
		return errors.New("connection profile name is required")
	}
	if p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "redis" && p.Driver != "sqlite" && p.Driver != "sqlserver" && p.Driver != "mongodb" {
		return errors.New("unsupported database driver: " + p.Driver)
	}
	// SQLite is a local file: the path lives in Database; host/port are unused.
	if p.Driver == "sqlite" {
		if p.Database == "" {
			return errors.New("database file path is required for sqlite")
		}
		return nil
	}
	// MongoDB connects via host+port OR a full connection URI.
	if p.Driver == "mongodb" {
		if p.ConnectionURI == "" && (p.Host == "" || p.Port <= 0 || p.Port > 65535) {
			return errors.New("mongodb requires either a connection URI or host+port")
		}
		return nil
	}
	if p.Host == "" {
		return errors.New("database host is required")
	}
	if p.Port <= 0 || p.Port > 65535 {
		return errors.New("invalid database port")
	}
	if (p.Driver == "mysql" || p.Driver == "postgres" || p.Driver == "sqlserver") && p.Database == "" {
		return errors.New("database name is required for relational databases")
	}
	return nil
}
