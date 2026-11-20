package adapters

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

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
	// Result delivery is independent of the permission gate. In particular,
	// a write inside a CTE can be followed by a result-producing outer SELECT.
	tokens, _ := domain.SQLTokens(query)
	// Parenthesized SELECTs are also supported by the classifier.
	for len(tokens) > 0 && tokens[0] == "(" {
		tokens = tokens[1:]
	}
	if len(tokens) == 0 {
		return false
	}
	depth := 0
	var outer []string
	for _, token := range tokens {
		switch token {
		case "(":
			depth++
		case ")":
			depth--
		default:
			if depth == 0 {
				outer = append(outer, token)
			}
		}
	}
	verb := tokens[0]
	if verb == "WITH" {
	findStatement:
		for i, token := range outer[1:] {
			switch token {
			case "SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE":
				verb = token
				outer = outer[i+1:]
				break findStatement
			}
		}
	}
	switch verb {
	case "SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "PRAGMA", "CALL", "VALUES", "TABLE":
		return true
	case "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE":
		for i, token := range outer {
			if token == "RETURNING" {
				return true
			}
			if token == "OUTPUT" {
				if i+1 < len(outer) && outer[i+1] == "=" {
					continue // ordinary unquoted column named output
				}
				// OUTPUT inserted.id INTO @saved writes to a destination rather
				// than returning rows. Do not match INTO inside quoted values.
				for _, following := range outer[i+1:] {
					if following == "INTO" {
						return false
					}
				}
				return true
			}
		}
	}
	return false
}

// IsPlainDMLWrite reports whether query is certainly a single INSERT / UPDATE /
// DELETE / REPLACE / MERGE (also behind WITH ...) that returns no rows (no
// RETURNING / OUTPUT). Only such statements may be run with ExecContext to get
// RowsAffected(); everything else (EXEC, DECLARE, PREPARE/EXECUTE, T-SQL batches,
// ...) must keep streaming rows with QueryContext, otherwise result sets are lost.
func IsPlainDMLWrite(query string) bool {
	tokens, complete := domain.SQLTokens(query)
	// Ambiguous tokenisation (odd escapes, unterminated quotes, nested or
	// executable comments) cannot prove the statement returns no rows.
	if !complete {
		return false
	}
	for len(tokens) > 0 && tokens[0] == ";" {
		tokens = tokens[1:]
	}
	// A second statement (anything after a ';') could be a SELECT: not plain.
	for i, token := range tokens {
		if token == ";" {
			for _, rest := range tokens[i+1:] {
				if rest != ";" {
					return false
				}
			}
			tokens = tokens[:i]
			break
		}
	}
	if len(tokens) == 0 || tokens[0] == "(" {
		return false
	}
	depth := 0
	var outer []string
	for _, token := range tokens {
		switch token {
		case "(":
			depth++
		case ")":
			depth--
		default:
			if depth == 0 {
				outer = append(outer, token)
			}
		}
	}
	if depth != 0 || len(outer) == 0 {
		return false
	}
	verb := outer[0]
	if verb == "WITH" {
		verb = ""
		for _, token := range outer[1:] {
			switch token {
			case "SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE":
				verb = token
			}
			if verb != "" {
				break
			}
		}
	}
	switch verb {
	case "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE":
	default:
		return false
	}
	// RETURNING / OUTPUT decided on the same normalised tokens.
	for i, token := range outer {
		switch token {
		case "RETURNING":
			return false
		case "OUTPUT":
			if i+1 < len(outer) && outer[i+1] == "=" {
				continue // ordinary unquoted column named output
			}
			// OUTPUT ... INTO @t writes to a destination rather than returning rows.
			into := false
			for _, following := range outer[i+1:] {
				if following == "INTO" {
					into = true
					break
				}
			}
			if !into {
				return false
			}
		}
	}
	return true
}

// ExecuteStatelessQuery runs one statement on a non-session connection. Plain DML
// without RETURNING goes through ExecContext so RowsAffected() is reported;
// everything else is streamed with QueryContext exactly as before.
func ExecuteStatelessQuery(
	ctx context.Context,
	queryer sqlsession.Queryer,
	query string,
	onHeader func([]string) error,
	onRow func([]any) error,
) (int64, error) {
	if IsPlainDMLWrite(query) {
		return ExecuteSessionQuery(ctx, queryer, query, onHeader, onRow)
	}
	rows, err := queryer.QueryContext(ctx, query) // codeql[go/sql-injection]
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	return StreamRows(rows, onHeader, onRow)
}
