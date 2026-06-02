package agent

import (
	"regexp"
	"strings"
)

type Risk string

const (
	RiskSafe      Risk = "safe"
	RiskDangerous Risk = "dangerous"
)

// Classification is the result of inspecting a single SQL statement.
type Classification struct {
	Risk    Risk     `json:"risk"`
	Reasons []string `json:"reasons"`
}

var (
	reLineComment  = regexp.MustCompile(`--[^\n]*`)
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	reString       = regexp.MustCompile(`'(?:[^']|'')*'`)
	reWhitespace   = regexp.MustCompile(`\s+`)
	reWhere        = regexp.MustCompile(`(?i)\bWHERE\b`)
)

// normalize strips comments and string literals, then collapses whitespace so
// keyword checks can't be fooled by text inside strings/comments.
func normalize(sql string) string {
	s := reLineComment.ReplaceAllString(sql, " ")
	s = reBlockComment.ReplaceAllString(s, " ")
	s = reString.ReplaceAllString(s, "''")
	s = reWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ClassifyStatement flags statements that drop/wipe data or mutate without a
// WHERE clause. It is intentionally conservative: anything matching is dangerous.
func ClassifyStatement(sql string) Classification {
	n := normalize(sql)
	upper := strings.ToUpper(n)
	var reasons []string

	switch {
	case strings.HasPrefix(upper, "DROP "):
		reasons = append(reasons, "DROP removes a database object")
	case strings.HasPrefix(upper, "TRUNCATE"):
		reasons = append(reasons, "TRUNCATE empties a table")
	case strings.HasPrefix(upper, "DELETE") && !reWhere.MatchString(n):
		reasons = append(reasons, "DELETE without a WHERE clause affects every row")
	case strings.HasPrefix(upper, "UPDATE") && !reWhere.MatchString(n):
		reasons = append(reasons, "UPDATE without a WHERE clause affects every row")
	}
	if strings.HasPrefix(upper, "ALTER") && strings.Contains(upper, " DROP ") {
		reasons = append(reasons, "ALTER ... DROP removes a column/constraint")
	}

	if len(reasons) > 0 {
		return Classification{Risk: RiskDangerous, Reasons: reasons}
	}
	return Classification{Risk: RiskSafe}
}
