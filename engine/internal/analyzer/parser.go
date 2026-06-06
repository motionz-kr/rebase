package analyzer

import (
	"regexp"
	"strings"
)

type ParsedDML struct {
	Verb        string   `json:"verb"`
	Table       string   `json:"table"`
	WhereClause string   `json:"whereClause"`
	HasWhere    bool     `json:"hasWhere"`
	SetCols     []string `json:"setCols"`
	Parseable   bool     `json:"parseable"`
}

var (
	updateRe = regexp.MustCompile(`(?is)^\s*UPDATE\s+([` + "`" + `"\[\]\w.]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?\s*;?\s*$`)
	deleteRe = regexp.MustCompile(`(?is)^\s*DELETE\s+FROM\s+([` + "`" + `"\[\]\w.]+)(?:\s+WHERE\s+(.+))?\s*;?\s*$`)
)

// ParseDML extracts table/where/set-columns from a single-table UPDATE or
// DELETE. Anything it cannot confidently parse (JOIN, subquery, multi-statement,
// non-DML) yields Parseable=false so the caller skips COUNT/preview/rollback.
func ParseDML(query string) ParsedDML {
	q := stripComments(query)
	if strings.Contains(strings.TrimRight(strings.TrimSpace(q), ";"), ";") {
		return ParsedDML{}
	}
	upper := strings.ToUpper(q)
	if strings.Contains(upper, " JOIN ") || strings.Contains(upper, " USING ") {
		return ParsedDML{}
	}

	if m := updateRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if strings.Contains(table, ",") {
			return ParsedDML{}
		}
		where := strings.TrimSpace(m[3])
		return ParsedDML{
			Verb:        "UPDATE",
			Table:       table,
			WhereClause: where,
			HasWhere:    where != "",
			SetCols:     setColumns(m[2]),
			Parseable:   true,
		}
	}
	if m := deleteRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if strings.Contains(table, ",") {
			return ParsedDML{}
		}
		where := strings.TrimSpace(m[2])
		return ParsedDML{
			Verb:        "DELETE",
			Table:       table,
			WhereClause: where,
			HasWhere:    where != "",
			Parseable:   true,
		}
	}
	return ParsedDML{}
}

// setColumns extracts the left-hand column names from a SET clause, splitting on
// top-level commas (ignoring commas inside parentheses, e.g. function calls).
func setColumns(setClause string) []string {
	var cols []string
	depth := 0
	start := 0
	parts := []string{}
	for i, r := range setClause {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, setClause[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, setClause[start:])
	for _, p := range parts {
		if eq := strings.Index(p, "="); eq >= 0 {
			cols = append(cols, unquoteIdent(strings.TrimSpace(p[:eq])))
		}
	}
	return cols
}

func unquoteIdent(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "`\"[]")
	return s
}

// stripComments removes -- line and /* */ block comments (mirrors the domain
// classifier so the parser sees the same cleaned text).
func stripComments(s string) string {
	reLine := regexp.MustCompile(`--[^\n]*`)
	reBlock := regexp.MustCompile(`(?s)/\*.*?\*/`)
	return reBlock.ReplaceAllString(reLine.ReplaceAllString(s, " "), " ")
}
