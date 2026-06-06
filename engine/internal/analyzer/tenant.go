package analyzer

import (
	"regexp"
	"strings"
)

// ReferencesColumn reports whether clause references col as a whole word
// (case-insensitive). Used to detect tenant-scope predicates.
func ReferencesColumn(clause, col string) bool {
	if clause == "" || col == "" {
		return false
	}
	re := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(col) + `\b`)
	return re.MatchString(clause)
}

// IntersectColumns returns the configured tenant columns that the table actually
// has (case-insensitive match), preserving the configured spelling.
func IntersectColumns(tableColumns, tenantColumns []string) []string {
	have := map[string]bool{}
	for _, c := range tableColumns {
		have[strings.ToLower(c)] = true
	}
	var out []string
	for _, tc := range tenantColumns {
		if have[strings.ToLower(tc)] {
			out = append(out, tc)
		}
	}
	return out
}

// ApplyTenantCheck finalises tenant-missing detection using the target table's
// actual columns. tableTenantCols is the intersection of the table's columns
// with the connection's configured tenant columns (computed by the handler via
// introspection). If the table has tenant columns but the WHERE clause
// references none of them, the statement is flagged. In safe mode a tenant miss
// is High; otherwise Warn (unless already higher). tableColumns is accepted for
// signature symmetry with the handler call site (intersection is precomputed via
// IntersectColumns) and is intentionally unused here.
func ApplyTenantCheck(r RiskReport, tableColumns, tableTenantCols []string, safeMode bool) RiskReport {
	if !r.Parseable || len(tableTenantCols) == 0 {
		return r
	}
	for _, tc := range tableTenantCols {
		if ReferencesColumn(r.WhereClause, tc) {
			return r
		}
	}
	r.TenantMissing = true
	r.Reasons = append(r.Reasons, "tenant 조건("+strings.Join(tableTenantCols, "/")+") 없이 실행됩니다")
	if safeMode {
		r.Level = RiskHigh
	} else if r.Level == RiskSafe || r.Level == RiskMedium {
		r.Level = RiskWarn
	}
	return r
}
