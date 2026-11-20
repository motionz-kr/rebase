package sqlsession

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var autoCommitSetting = regexp.MustCompile(`(?i)^SET\s+(?:(?:SESSION|LOCAL)\s+|@@(?:SESSION\.|LOCAL\.)?)?AUTOCOMMIT\s*(?::=|=)\s*(0|1|ON|OFF)\s*;?$`)

var setKeyword = regexp.MustCompile(`(?i)^SET\b`)

// stripLeadingComments removes only leading whitespace and comments (`--`, `#`,
// `/* */`). It never looks inside quotes, so a comment marker in a string later
// in the statement cannot hide anything from the check below.
func stripLeadingComments(query string) string {
	for {
		query = strings.TrimLeftFunc(query, unicode.IsSpace)
		switch {
		case strings.HasPrefix(query, "--"), strings.HasPrefix(query, "#"):
			end := strings.IndexByte(query, '\n')
			if end < 0 {
				return ""
			}
			query = query[end+1:]
		case strings.HasPrefix(query, "/*"):
			end := strings.Index(query[2:], "*/")
			if end < 0 {
				return ""
			}
			query = query[end+4:]
		default:
			return query
		}
	}
}

// mysqlMayChangeAutoCommit is deliberately broader than mysqlAutoCommit, which
// tracks session state only for the simple single-assignment form. Turning
// autocommit on commits pending work, so for loss classification a statement that
// starts with SET and mentions autocommit anywhere (lists, @@autocommit,
// SESSION/LOCAL, any value, even inside quotes) counts as a possible commit
// boundary. Over-matching only makes the reported outcome more cautious.
func mysqlMayChangeAutoCommit(query string) bool {
	text := stripLeadingComments(query)
	return setKeyword.MatchString(text) && strings.Contains(strings.ToLower(text), "autocommit")
}

func mysqlAutoCommit(query string) (bool, bool) {
	match := autoCommitSetting.FindStringSubmatch(domain.StatementText(query))
	if match == nil {
		return false, false
	}
	return match[1] == "1" || strings.EqualFold(match[1], "ON"), true
}

func mysqlImplicitCommit(query string) bool {
	text := strings.ToUpper(strings.Join(strings.Fields(domain.StatementText(query)), " "))
	if strings.HasPrefix(text, "CREATE TEMPORARY TABLE") || strings.HasPrefix(text, "DROP TEMPORARY TABLE") {
		return false
	}
	switch domain.ClassifyQuery(query).Verb {
	case "ALTER", "CREATE", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE", "ANALYZE", "OPTIMIZE", "REPAIR", "FLUSH":
		return true
	case "LOCK":
		return strings.HasPrefix(text, "LOCK TABLES")
	}
	return false
}
