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
	updateHeadRe   = regexp.MustCompile("(?is)^\\s*UPDATE\\s+([`\"\\[\\]\\w.]+)\\s+SET\\s+(.+)$")
	deleteHeadRe   = regexp.MustCompile("(?is)^\\s*DELETE\\s+FROM\\s+([`\"\\[\\]\\w.]+)\\s*(.*)$")
	reLineComment  = regexp.MustCompile(`--[^\n]*`)
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

// ParseDML extracts table/where/set-columns from a single-table UPDATE or
// DELETE. Anything it cannot confidently parse (JOIN, subquery, multi-statement,
// non-DML, schema-qualified table) yields Parseable=false so the caller skips
// COUNT/preview/rollback. WHERE detection is string-literal and paren aware.
func ParseDML(query string) ParsedDML {
	q := stripComments(query)
	if hasExtraStatement(q) {
		return ParsedDML{}
	}
	upper := strings.ToUpper(q)
	if strings.Contains(upper, " JOIN ") || strings.Contains(upper, " USING ") {
		return ParsedDML{}
	}

	if m := updateHeadRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if !validTable(table) {
			return ParsedDML{}
		}
		setClause, where, hasWhere := splitWhere(m[2])
		return ParsedDML{
			Verb:        "UPDATE",
			Table:       table,
			WhereClause: where,
			HasWhere:    hasWhere,
			SetCols:     setColumns(setClause),
			Parseable:   true,
		}
	}
	if m := deleteHeadRe.FindStringSubmatch(q); m != nil {
		table := unquoteIdent(m[1])
		if !validTable(table) {
			return ParsedDML{}
		}
		_, where, hasWhere := splitWhere(m[2])
		return ParsedDML{
			Verb:        "DELETE",
			Table:       table,
			WhereClause: where,
			HasWhere:    hasWhere,
			Parseable:   true,
		}
	}
	return ParsedDML{}
}

// validTable rejects empty, comma-listed, or schema-qualified table names.
func validTable(t string) bool {
	return t != "" && !strings.Contains(t, ".") && !strings.Contains(t, ",")
}

// splitWhere splits a statement body at the LAST top-level WHERE keyword
// (outside string literals and parentheses). Returns the part before WHERE,
// the WHERE predicate (with trailing ORDER BY/LIMIT stripped), and whether a
// WHERE was found.
func splitWhere(body string) (before, where string, hasWhere bool) {
	idxs := topLevelKeywordIndices(body, "WHERE")
	if len(idxs) == 0 {
		return body, "", false
	}
	last := idxs[len(idxs)-1]
	before = body[:last]
	where = strings.TrimSpace(body[last+len("WHERE"):])
	where = stripTrailingClauses(where)
	return before, where, true
}

// stripTrailingClauses removes a trailing top-level ORDER BY / LIMIT tail from a
// WHERE predicate so COUNT(*) mirrors only the row filter.
func stripTrailingClauses(where string) string {
	cut := len(where)
	for _, kw := range []string{"ORDER BY", "LIMIT"} {
		if idxs := topLevelKeywordIndices(where, kw); len(idxs) > 0 && idxs[0] < cut {
			cut = idxs[0]
		}
	}
	return strings.TrimSpace(where[:cut])
}

// topLevelKeywordIndices returns the byte indices where keyword appears as a
// whole word (case-insensitive) outside single-quote string literals and
// parentheses. Single quotes escape via doubling ('').
func topLevelKeywordIndices(s, keyword string) []int {
	up := strings.ToUpper(s)
	kw := strings.ToUpper(keyword)
	n := len(s)
	var idxs []int
	inStr := false
	depth := 0
	for i := 0; i < n; i++ {
		c := s[i]
		if inStr {
			if c == '\'' {
				if i+1 < n && s[i+1] == '\'' {
					i++
				} else {
					inStr = false
				}
			}
			continue
		}
		switch c {
		case '\'':
			inStr = true
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 && i+len(kw) <= n && up[i:i+len(kw)] == kw {
				beforeOK := i == 0 || !isWordByte(s[i-1])
				afterOK := i+len(kw) == n || !isWordByte(s[i+len(kw)])
				if beforeOK && afterOK {
					idxs = append(idxs, i)
				}
			}
		}
	}
	return idxs
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// hasExtraStatement reports a top-level (outside literal/paren) semicolon that is
// followed by more than whitespace — i.e. a real second statement.
func hasExtraStatement(s string) bool {
	n := len(s)
	inStr := false
	depth := 0
	for i := 0; i < n; i++ {
		c := s[i]
		if inStr {
			if c == '\'' {
				if i+1 < n && s[i+1] == '\'' {
					i++
				} else {
					inStr = false
				}
			}
			continue
		}
		switch c {
		case '\'':
			inStr = true
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ';':
			if depth == 0 && strings.TrimSpace(s[i+1:]) != "" {
				return true
			}
		}
	}
	return false
}

// setColumns extracts the left-hand column names from a SET clause, splitting on
// top-level commas (ignoring commas inside parentheses). Values to the right of
// '=' are ignored, so commas inside string literals do not corrupt the column
// list.
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
	return strings.Trim(s, "`\"[]")
}

// stripComments removes -- line and /* */ block comments.
func stripComments(s string) string {
	return reBlockComment.ReplaceAllString(reLineComment.ReplaceAllString(s, " "), " ")
}
