package domain

import "strings"

// QueryClass is the advisory classification of a SQL statement. It is NOT a
// security boundary on its own — SQL parsing is imperfect, so the engine treats
// this as a conservative gate (read-only by default, explicit confirmation for
// destructive statements) and leans toward marking ambiguous input as unsafe.
type QueryClass struct {
	// ReadOnly is true only when the statement is confidently read-only.
	ReadOnly bool
	// Destructive marks statements that can drop/alter schema, change
	// privileges, or modify/remove large amounts of data without a predicate.
	Destructive bool
	// Verb is the detected leading keyword (uppercased), or "MULTI" for a
	// multi-statement script that we refuse to classify confidently.
	Verb string
}

// ClassifyQuery inspects a single SQL string and returns a conservative
// classification. Unknown or ambiguous input is treated as a non-read-only
// statement so that the caller's read-only gate blocks it by default.
func ClassifyQuery(query string) QueryClass {
	cleaned := stripSQLComments(query)
	trimmed := strings.TrimSpace(cleaned)
	if trimmed == "" {
		// Nothing to run; harmless.
		return QueryClass{ReadOnly: true}
	}

	// Multiple statements can smuggle a write past a read-only check
	// (e.g. "SELECT 1; DROP TABLE x"). We don't trust a hand-rolled splitter,
	// so any extra statement marks the whole script unsafe.
	if hasMultipleStatements(trimmed) {
		return QueryClass{ReadOnly: false, Destructive: true, Verb: "MULTI"}
	}

	upper := strings.ToUpper(trimmed)
	verb := firstWord(upper)

	switch verb {
	case "SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "PRAGMA":
		return QueryClass{ReadOnly: true, Verb: verb}

	case "WITH":
		// A CTE is read-only unless its body performs a write.
		if containsWriteVerb(upper) {
			return QueryClass{ReadOnly: false, Verb: verb}
		}
		return QueryClass{ReadOnly: true, Verb: verb}

	case "DROP", "TRUNCATE", "ALTER", "GRANT", "REVOKE", "RENAME":
		return QueryClass{ReadOnly: false, Destructive: true, Verb: verb}

	case "DELETE", "UPDATE":
		// Without a WHERE clause these affect every row in the table.
		hasWhere := strings.Contains(upper, " WHERE ") || strings.HasSuffix(upper, " WHERE")
		return QueryClass{ReadOnly: false, Destructive: !hasWhere, Verb: verb}

	case "CREATE":
		// Creating users/roles changes who can access the database.
		destructive := strings.HasPrefix(upper, "CREATE USER") || strings.HasPrefix(upper, "CREATE ROLE")
		return QueryClass{ReadOnly: false, Destructive: destructive, Verb: verb}

	case "INSERT", "REPLACE", "MERGE", "CALL", "SET", "USE", "BEGIN", "START", "COMMIT", "ROLLBACK":
		return QueryClass{ReadOnly: false, Verb: verb}

	default:
		// Unrecognized leading keyword: assume it can write so the read-only
		// gate blocks it until the caller explicitly opts into writes.
		return QueryClass{ReadOnly: false, Verb: verb}
	}
}

func containsWriteVerb(upper string) bool {
	for _, v := range []string{"INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT", "REVOKE"} {
		if strings.Contains(upper, v) {
			return true
		}
	}
	return false
}

// firstWord returns the leading identifier of a statement, skipping a leading
// open paren (e.g. "(SELECT ...)").
func firstWord(s string) string {
	s = strings.TrimLeft(s, "( \t\r\n")
	end := strings.IndexFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\r' || r == '\n' || r == '(' || r == ';'
	})
	if end < 0 {
		return s
	}
	return s[:end]
}

// hasMultipleStatements reports whether more than one statement is present.
// A single trailing semicolon is allowed. This is intentionally naive: a
// semicolon inside a string literal yields a false positive, which only makes
// the classifier more conservative (the statement gets blocked), never less.
func hasMultipleStatements(s string) bool {
	s = strings.TrimRight(s, "; \t\r\n")
	return strings.Contains(s, ";")
}

// stripSQLComments removes -- line comments and /* */ block comments so the
// leading verb isn't hidden behind a comment.
func stripSQLComments(s string) string {
	var b strings.Builder
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		// Line comment: -- ... \n
		if runes[i] == '-' && i+1 < len(runes) && runes[i+1] == '-' {
			for i < len(runes) && runes[i] != '\n' {
				i++
			}
			if i < len(runes) {
				b.WriteRune('\n')
			}
			continue
		}
		// Block comment: /* ... */
		if runes[i] == '/' && i+1 < len(runes) && runes[i+1] == '*' {
			i += 2
			for i+1 < len(runes) && !(runes[i] == '*' && runes[i+1] == '/') {
				i++
			}
			i++ // land on '/', loop's i++ moves past it
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(runes[i])
	}
	return b.String()
}
