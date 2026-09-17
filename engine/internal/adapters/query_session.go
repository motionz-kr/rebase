package adapters

import (
	"context"
	"regexp"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var sessionResultClause = regexp.MustCompile(`(?i)\b(RETURNING|OUTPUT)\b`)
var sessionOutputIntoClause = regexp.MustCompile(`(?i)\bOUTPUT\s+INTO\b`)

// ExecuteSessionQuery streams result-producing SQL and uses ExecContext for
// statements without result rows so affected-row counts remain available.
func ExecuteSessionQuery(
	ctx context.Context,
	queryer sqlsession.Queryer,
	query string,
	onHeader func([]string) error,
	onRow func([]any) error,
) (int64, error) {
	if sessionQueryReturnsRows(query) {
		rows, err := queryer.QueryContext(ctx, query) // codeql[go/sql-injection]
		if err != nil {
			return 0, err
		}
		defer rows.Close()
		return StreamRows(rows, onHeader, onRow)
	}

	result, err := queryer.ExecContext(ctx, query) // codeql[go/sql-injection]
	if err != nil {
		return 0, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if onHeader != nil {
		if err := onHeader([]string{}); err != nil {
			return rowsAffected, err
		}
	}
	return rowsAffected, nil
}

func sessionQueryReturnsRows(query string) bool {
	class := domain.ClassifyQuery(query)
	if class.ReadOnly || class.Verb == "CALL" {
		return true
	}
	// DML can return rows in PostgreSQL/SQLite (RETURNING), SQL Server
	// (OUTPUT), and stored procedures can emit result sets via CALL.
	if !sessionResultClause.MatchString(query) {
		return false
	}
	// SQL Server's OUTPUT INTO writes to another table without returning a
	// result set to the client, so retain ExecContext for its affected count.
	return !sessionOutputIntoClause.MatchString(query)
}
