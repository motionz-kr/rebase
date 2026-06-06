package analyzer

import "strings"

// QuoteIdent quotes a SQL identifier for the given driver, escaping the closing
// quote character by doubling (or, for sqlserver, doubling the closing bracket).
func QuoteIdent(driver, name string) string {
	switch driver {
	case "mysql":
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	case "sqlserver":
		return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
	default: // postgres, sqlite
		return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	}
}

func whereSuffix(p ParsedDML) string {
	if p.HasWhere && p.WhereClause != "" {
		return " WHERE " + p.WhereClause
	}
	return ""
}

// BuildCountSQL returns a read-only COUNT mirroring the DML's table+predicate,
// used to preview the affected-row count before execution.
func BuildCountSQL(driver string, p ParsedDML) string {
	return "SELECT COUNT(*) FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}

// BuildPreviewSQL returns a SELECT * over the same rows the DML would touch.
func BuildPreviewSQL(driver string, p ParsedDML) string {
	return "SELECT * FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}

// BuildSnapshotSQL returns the SELECT that captures the before-image needed to
// build rollback SQL. For UPDATE it selects pk + changed columns; for DELETE it
// selects all columns (SELECT *) so the full row can be re-inserted.
func BuildSnapshotSQL(driver string, p ParsedDML, pkCols []string) string {
	if p.Verb == "DELETE" {
		return "SELECT * FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
	}
	seen := map[string]bool{}
	var cols []string
	for _, c := range pkCols {
		if !seen[strings.ToLower(c)] {
			seen[strings.ToLower(c)] = true
			cols = append(cols, QuoteIdent(driver, c))
		}
	}
	for _, c := range p.SetCols {
		if !seen[strings.ToLower(c)] {
			seen[strings.ToLower(c)] = true
			cols = append(cols, QuoteIdent(driver, c))
		}
	}
	return "SELECT " + strings.Join(cols, ", ") + " FROM " + QuoteIdent(driver, p.Table) + whereSuffix(p)
}
