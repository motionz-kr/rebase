package analyzer

import "strings"

// BuildRollbackSQL generates best-effort rollback SQL text from a before-image
// snapshot of the affected rows.
//
//   - DELETE → one INSERT per snapshot row (full row, re-insert).
//   - UPDATE → one UPDATE per snapshot row restoring the changed columns,
//     keyed by primary key. Requires pkCols; returns ok=false without one.
//
// snapshotCols are the column names of each row in `rows` (same order). DDL,
// TRUNCATE and multi-table statements are not supported (ok=false).
func BuildRollbackSQL(driver string, p ParsedDML, snapshotCols, pkCols []string, rows [][]any) (string, bool) {
	if len(rows) == 0 {
		return "", false
	}
	switch p.Verb {
	case "DELETE":
		return buildDeleteRollback(driver, p, snapshotCols, rows), true
	case "UPDATE":
		if len(pkCols) == 0 {
			return "", false
		}
		return buildUpdateRollback(driver, p, snapshotCols, pkCols, rows)
	default:
		return "", false
	}
}

func buildDeleteRollback(driver string, p ParsedDML, cols []string, rows [][]any) string {
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = QuoteIdent(driver, c)
	}
	var b strings.Builder
	prefix := "INSERT INTO " + QuoteIdent(driver, p.Table) + " (" + strings.Join(quoted, ", ") + ") VALUES "
	for _, row := range rows {
		vals := make([]string, len(row))
		for i, v := range row {
			vals[i] = FormatLiteral(driver, v)
		}
		b.WriteString(prefix + "(" + strings.Join(vals, ", ") + ");\n")
	}
	return b.String()
}

func buildUpdateRollback(driver string, p ParsedDML, cols, pkCols []string, rows [][]any) (string, bool) {
	// If a primary-key column is itself being updated, the before-image snapshot
	// (keyed on the old PK) cannot locate the row after the DML runs, so a
	// generated rollback would silently match zero rows. Refuse rather than
	// produce a misleading "rollback".
	for _, pk := range pkCols {
		for _, sc := range p.SetCols {
			if strings.EqualFold(pk, sc) {
				return "", false
			}
		}
	}
	idx := map[string]int{}
	for i, c := range cols {
		idx[strings.ToLower(c)] = i
	}
	for _, c := range pkCols {
		if _, ok := idx[strings.ToLower(c)]; !ok {
			return "", false
		}
	}
	for _, c := range p.SetCols {
		if _, ok := idx[strings.ToLower(c)]; !ok {
			return "", false
		}
	}
	var b strings.Builder
	for _, row := range rows {
		var sets, wheres []string
		for _, c := range p.SetCols {
			sets = append(sets, QuoteIdent(driver, c)+" = "+FormatLiteral(driver, row[idx[strings.ToLower(c)]]))
		}
		for _, c := range pkCols {
			wheres = append(wheres, QuoteIdent(driver, c)+" = "+FormatLiteral(driver, row[idx[strings.ToLower(c)]]))
		}
		b.WriteString("UPDATE " + QuoteIdent(driver, p.Table) + " SET " + strings.Join(sets, ", ") +
			" WHERE " + strings.Join(wheres, " AND ") + ";\n")
	}
	return b.String(), true
}
