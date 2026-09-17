package agent

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var mcpTableReference = regexp.MustCompile(`(?i)\b(?:from|join|update|into)\s+([^\s,;()]+)`)
var mcpFromOrJoin = regexp.MustCompile(`(?i)\b(?:from|join)\b`)

// mcpDefaultSchema is intentionally conservative and only covers the
// database families exposed by the SQL MCP registry.
func mcpDefaultSchema(driver, database string) string {
	switch driver {
	case "postgres":
		return "public"
	case "sqlserver":
		return "dbo"
	case "sqlite":
		return "main"
	default:
		// MySQL uses the database name as its schema.
		return database
	}
}

type mcpTableRef struct {
	database string
	schema   string
	table    string
}

func parseMCPTableRef(driver, defaultDatabase, raw string) (mcpTableRef, error) {
	raw = strings.TrimSpace(strings.TrimRight(raw, "."))
	if raw == "" {
		return mcpTableRef{}, fmt.Errorf("MCP table reference is empty")
	}
	parts := strings.Split(raw, ".")
	if len(parts) > 3 {
		return mcpTableRef{}, fmt.Errorf("unsupported MCP table reference %q", raw)
	}
	for i := range parts {
		parts[i] = strings.TrimSpace(strings.Trim(parts[i], "`\"[]"))
		if parts[i] == "" {
			return mcpTableRef{}, fmt.Errorf("invalid MCP table reference %q", raw)
		}
	}

	ref := mcpTableRef{database: defaultDatabase, schema: mcpDefaultSchema(driver, defaultDatabase)}
	switch len(parts) {
	case 1:
		ref.table = parts[0]
	case 2:
		if driver == "mysql" {
			ref.database, ref.table = parts[0], parts[1]
		} else {
			ref.schema, ref.table = parts[0], parts[1]
		}
	case 3:
		ref.database, ref.schema, ref.table = parts[0], parts[1], parts[2]
	}
	return ref, nil
}

func validateMCPRef(driver, defaultDatabase string, scope domain.MCPAccessScope, raw string) error {
	ref, err := parseMCPTableRef(driver, defaultDatabase, raw)
	if err != nil {
		return err
	}
	if !scope.AllowsDatabase(ref.database) {
		return fmt.Errorf("MCP database access denied: %s", ref.database)
	}
	if !scope.AllowsSchema(ref.schema) {
		return fmt.Errorf("MCP schema access denied: %s", ref.schema)
	}
	if !scope.AllowsTable(ref.schema, ref.table) {
		return fmt.Errorf("MCP table access denied: %s", raw)
	}
	return nil
}

// ValidateMCPTableRef checks a table argument used by metadata tools.
func ValidateMCPTableRef(driver, defaultDatabase string, scope domain.MCPAccessScope, table string) error {
	return validateMCPRef(driver, defaultDatabase, scope, table)
}

// ValidateMCPQueryScope conservatively validates table references in a query.
// When an allowlist is active, malformed SQL containing FROM/JOIN is denied
// instead of being treated as safe. Literals and comments are blanked before
// matching so words inside them cannot create false references.
func ValidateMCPQueryScope(driver, defaultDatabase string, scope domain.MCPAccessScope, query string) error {
	if len(scope.AllowedDatabases) == 0 && len(scope.AllowedSchemas) == 0 && len(scope.AllowedTables) == 0 {
		return nil
	}
	clean := stripMCPSQLNoise(query)
	refs := mcpTableReference.FindAllStringSubmatch(clean, -1)
	if mcpFromOrJoin.MatchString(clean) && len(refs) == 0 {
		return fmt.Errorf("MCP scope rejected an unparseable table reference")
	}
	for _, match := range refs {
		if err := validateMCPRef(driver, defaultDatabase, scope, match[1]); err != nil {
			return err
		}
	}
	return nil
}

func stripMCPSQLNoise(sql string) string {
	var b strings.Builder
	inSingle := false
	inLineComment := false
	inBlockComment := false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		var next byte
		if i+1 < len(sql) {
			next = sql[i+1]
		}
		if inLineComment {
			if c == '\n' {
				inLineComment = false
				b.WriteByte(c)
			} else {
				b.WriteByte(' ')
			}
			continue
		}
		if inBlockComment {
			if c == '*' && next == '/' {
				b.WriteString("  ")
				i++
				inBlockComment = false
			} else {
				b.WriteByte(' ')
			}
			continue
		}
		if inSingle {
			if c == '\'' {
				if next == '\'' {
					b.WriteString("  ")
					i++
				} else {
					inSingle = false
					b.WriteByte(' ')
				}
			} else {
				b.WriteByte(' ')
			}
			continue
		}
		if c == '\'' {
			inSingle = true
			b.WriteByte(' ')
		} else if c == '-' && next == '-' {
			b.WriteString("  ")
			i++
			inLineComment = true
		} else if c == '/' && next == '*' {
			b.WriteString("  ")
			i++
			inBlockComment = true
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// FilterMCPTableNames removes metadata for tables outside the configured
// scope. The current SQL adapters expose the default schema's table names.
func FilterMCPTableNames(driver, defaultDatabase string, scope domain.MCPAccessScope, names []string) []string {
	if len(scope.AllowedSchemas) > 0 && !scope.AllowsSchema(mcpDefaultSchema(driver, defaultDatabase)) {
		return []string{}
	}
	out := make([]string, 0, len(names))
	for _, name := range names {
		if scope.AllowsTable(mcpDefaultSchema(driver, defaultDatabase), name) {
			out = append(out, name)
		}
	}
	return out
}
