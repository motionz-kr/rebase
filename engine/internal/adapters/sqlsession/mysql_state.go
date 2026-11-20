package sqlsession

import (
	"regexp"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var autoCommitSetting = regexp.MustCompile(`(?i)^SET\s+(?:(?:SESSION|LOCAL)\s+|@@(?:SESSION\.|LOCAL\.)?)?AUTOCOMMIT\s*(?::=|=)\s*(0|1|ON|OFF)\s*;?$`)

// mentionsAutoCommit matches any SET statement naming autocommit, whatever its
// spelling (lists, @@autocommit, SESSION/LOCAL, any value or expression).
var mentionsAutoCommit = regexp.MustCompile(`(?is)^SET\b.*\bAUTOCOMMIT\b`)

// mysqlMayChangeAutoCommit is deliberately broader than mysqlAutoCommit, which
// tracks session state only for the simple single-assignment form. Turning
// autocommit on commits pending work, so for loss classification any SET that
// mentions it counts as a possible commit boundary.
func mysqlMayChangeAutoCommit(query string) bool {
	return mentionsAutoCommit.MatchString(domain.StatementText(query))
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
