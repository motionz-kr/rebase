// Package analyzer performs pre-execution risk analysis of SQL statements:
// classification, single-table parsing, and dialect-aware SQL/rollback
// generation. It is the engine-side source of truth for safe execution mode
// (#102). All functions in this file are pure (no DB access).
package analyzer

import (
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type RiskLevel string

const (
	RiskSafe   RiskLevel = "safe"
	RiskWarn   RiskLevel = "warn"
	RiskMedium RiskLevel = "medium"
	RiskHigh   RiskLevel = "high"
)

// RiskReport is the static (no-DB) analysis of a single SQL statement.
type RiskReport struct {
	Level         RiskLevel `json:"level"`
	Verb          string    `json:"verb"`
	Reasons       []string  `json:"reasons"`
	Table         string    `json:"table"`
	HasWhere      bool      `json:"hasWhere"`
	WhereClause   string    `json:"whereClause"`
	TenantMissing bool      `json:"tenantMissing"`
	Parseable     bool      `json:"parseable"`
	Parsed        ParsedDML `json:"-"`
}

// Analyze produces the static risk report. tenantColumns is the connection's
// configured tenant-scope columns; tenant-missing is finalised by the handler
// after introspection (see ApplyTenantCheck), but Analyze pre-fills WhereClause
// and a textual tenant hint.
func Analyze(query string, tenantColumns []string) RiskReport {
	class := domain.ClassifyQuery(query)
	parsed := ParseDML(query)

	r := RiskReport{
		Verb:        class.Verb,
		Table:       parsed.Table,
		HasWhere:    parsed.HasWhere,
		WhereClause: parsed.WhereClause,
		Parseable:   parsed.Parseable,
		Parsed:      parsed,
		Reasons:     []string{},
	}

	upperVerb := strings.ToUpper(class.Verb)
	switch {
	case upperVerb == "DROP" || upperVerb == "TRUNCATE" || upperVerb == "ALTER":
		r.Level = RiskHigh
		r.Reasons = append(r.Reasons, upperVerb+" 문은 스키마/데이터를 되돌리기 어렵게 변경합니다")
	case (upperVerb == "UPDATE" || upperVerb == "DELETE") && !parsed.HasWhere:
		r.Level = RiskHigh
		r.Reasons = append(r.Reasons, upperVerb+" 문에 WHERE가 없어 모든 row에 영향을 줍니다")
	case upperVerb == "UPDATE" || upperVerb == "DELETE":
		r.Level = RiskMedium
		r.Reasons = append(r.Reasons, upperVerb+" 문은 데이터를 변경합니다")
	case class.ReadOnly:
		r.Level = RiskSafe
	default:
		r.Level = RiskMedium
		if class.Destructive {
			r.Level = RiskHigh
		}
		r.Reasons = append(r.Reasons, "데이터를 변경할 수 있는 문입니다")
	}
	return r
}
