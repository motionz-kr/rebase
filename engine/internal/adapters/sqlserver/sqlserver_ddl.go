package sqlserver

import (
	"strconv"
	"strings"
)

// DDLColumn is one column for CREATE TABLE reconstruction.
type DDLColumn struct {
	Name         string
	Type         string // full type incl. length/precision, e.g. "nvarchar(255)", "decimal(10,2)"
	Nullable     bool
	Identity     bool
	IdentitySeed int64
	IdentityIncr int64
	Default      string // raw default expression incl. parens, e.g. "('')"; empty for none
}

// quoteIdent quotes a SQL Server identifier with [brackets], escaping ] as ]].
func quoteIdent(name string) string {
	return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
}

// BuildCreateTableDDL reconstructs a CREATE TABLE statement from catalog data.
// Pure + unit-tested (no server needed).
func BuildCreateTableDDL(schema, table string, cols []DDLColumn, pk []string) string {
	lines := make([]string, 0, len(cols)+1)
	for _, c := range cols {
		s := "  " + quoteIdent(c.Name) + " " + c.Type
		if c.Identity {
			s += " IDENTITY(" + strconv.FormatInt(c.IdentitySeed, 10) + "," + strconv.FormatInt(c.IdentityIncr, 10) + ")"
		}
		if c.Nullable {
			s += " NULL"
		} else {
			s += " NOT NULL"
		}
		if strings.TrimSpace(c.Default) != "" {
			s += " DEFAULT " + strings.TrimSpace(c.Default)
		}
		lines = append(lines, s)
	}
	if len(pk) > 0 {
		qpk := make([]string, len(pk))
		for i, c := range pk {
			qpk[i] = quoteIdent(c)
		}
		lines = append(lines, "  CONSTRAINT "+quoteIdent("PK_"+table)+" PRIMARY KEY ("+strings.Join(qpk, ", ")+")")
	}
	return "CREATE TABLE " + quoteIdent(schema) + "." + quoteIdent(table) + " (\n" + strings.Join(lines, ",\n") + "\n)"
}
