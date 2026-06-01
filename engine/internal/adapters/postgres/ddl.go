package postgres

import "strings"

// pgColumn is a single column's metadata used to reconstruct a CREATE TABLE.
type pgColumn struct {
	Name    string
	Type    string // canonical type from format_type(), e.g. "character varying(80)"
	NotNull bool
	Default string // pg_get_expr() of the column default, or "" if none
}

// buildPostgresCreateTable reconstructs a readable CREATE TABLE statement from
// column metadata and the primary-key column list. PostgreSQL has no single
// "show DDL" command, so this is an approximation: it covers columns, types,
// NOT NULL, defaults, and the primary key (not indexes, FKs, or checks).
func buildPostgresCreateTable(schema, table string, cols []pgColumn, pk []string) string {
	lines := make([]string, 0, len(cols)+1)
	for _, c := range cols {
		line := "    " + c.Name + " " + c.Type
		if c.NotNull {
			line += " NOT NULL"
		}
		if c.Default != "" {
			line += " DEFAULT " + c.Default
		}
		lines = append(lines, line)
	}
	if len(pk) > 0 {
		lines = append(lines, "    PRIMARY KEY ("+strings.Join(pk, ", ")+")")
	}

	var b strings.Builder
	b.WriteString("CREATE TABLE ")
	b.WriteString(schema)
	b.WriteString(".")
	b.WriteString(table)
	b.WriteString(" (\n")
	b.WriteString(strings.Join(lines, ",\n"))
	b.WriteString("\n);")
	return b.String()
}
