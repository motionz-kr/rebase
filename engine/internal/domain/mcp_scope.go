package domain

import (
	"encoding/json"
	"strings"
)

// MCPAccessScope is the engine-enforced allowlist for one exposed connection.
// Empty lists intentionally preserve the behavior of profiles created before
// scope governance was introduced.
type MCPAccessScope struct {
	AllowedDatabases []string `json:"allowedDatabases"`
	AllowedSchemas   []string `json:"allowedSchemas"`
	AllowedTables    []string `json:"allowedTables"`
}

func (s MCPAccessScope) AllowsDatabase(name string) bool {
	return allowsExact(s.AllowedDatabases, name)
}

func (s MCPAccessScope) AllowsSchema(name string) bool {
	return allowsExact(s.AllowedSchemas, name)
}

// AllowsTable accepts either an unqualified table name or an exact
// schema-qualified entry such as public.orders.
func (s MCPAccessScope) AllowsTable(schema, table string) bool {
	if len(s.AllowedTables) == 0 {
		return true
	}
	for _, allowed := range s.AllowedTables {
		allowed = strings.TrimSpace(allowed)
		if allowed == table || allowed == schema+"."+table {
			return true
		}
	}
	return false
}

func allowsExact(allowed []string, name string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, candidate := range allowed {
		if strings.TrimSpace(candidate) == name {
			return true
		}
	}
	return false
}

func decodeMCPList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var values []string
	if json.Unmarshal([]byte(raw), &values) == nil {
		return cleanMCPList(values)
	}
	return cleanMCPList(strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' }))
}

func cleanMCPList(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func encodeMCPList(values []string) string {
	clean := cleanMCPList(values)
	if len(clean) == 0 {
		return ""
	}
	b, _ := json.Marshal(clean)
	return string(b)
}

// MCPAccessScope reads the persisted JSON-list fields from a connection
// profile. Invalid legacy values degrade to comma/newline separated entries.
func (p ConnectionProfile) MCPAccessScope() MCPAccessScope {
	return MCPAccessScope{
		AllowedDatabases: decodeMCPList(p.McpAllowedDatabases),
		AllowedSchemas:   decodeMCPList(p.McpAllowedSchemas),
		AllowedTables:    decodeMCPList(p.McpAllowedTables),
	}
}

// SetMCPAccessScope stores normalized JSON lists in the profile metadata.
func (p *ConnectionProfile) SetMCPAccessScope(scope MCPAccessScope) {
	p.McpAllowedDatabases = encodeMCPList(scope.AllowedDatabases)
	p.McpAllowedSchemas = encodeMCPList(scope.AllowedSchemas)
	p.McpAllowedTables = encodeMCPList(scope.AllowedTables)
}
