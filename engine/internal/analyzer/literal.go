package analyzer

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// FormatLiteral renders a Go value (as returned by database/sql) as an inline
// SQL literal for the given driver. Strings/bytes are single-quote escaped;
// booleans follow each dialect's convention. Used to build rollback SQL text —
// the values originate from the DB itself and the output is shown to the user,
// not auto-executed, but correct escaping still matters.
func FormatLiteral(driver string, v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case bool:
		return formatBool(driver, x)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case uint64:
		return strconv.FormatUint(x, 10)
	case uint:
		return strconv.FormatUint(uint64(x), 10)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	case []byte:
		return quoteString(string(x))
	case string:
		return quoteString(x)
	case time.Time:
		return "'" + x.Format("2006-01-02 15:04:05") + "'"
	default:
		return quoteString(fmt.Sprintf("%v", x))
	}
}

func formatBool(driver string, b bool) string {
	if driver == "postgres" {
		if b {
			return "TRUE"
		}
		return "FALSE"
	}
	if b {
		return "1"
	}
	return "0"
}

func quoteString(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
