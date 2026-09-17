package adapters

import (
	"database/sql"
)

// StreamRows forwards one result set without buffering it in memory.
func StreamRows(rows *sql.Rows, onHeader func([]string) error, onRow func([]any) error) (int64, error) {
	columns, err := rows.Columns()
	if err != nil {
		return 0, err
	}
	if err := onHeader(columns); err != nil {
		return 0, err
	}

	values := make([]any, len(columns))
	valuePointers := make([]any, len(columns))
	for i := range values {
		valuePointers[i] = &values[i]
	}
	var rowsAffected int64
	for rows.Next() {
		if err := rows.Scan(valuePointers...); err != nil {
			return rowsAffected, err
		}
		row := make([]any, len(values))
		for i, value := range values {
			if bytes, ok := value.([]byte); ok {
				row[i] = string(bytes)
			} else {
				row[i] = value
			}
		}
		if err := onRow(row); err != nil {
			return rowsAffected, err
		}
		rowsAffected++
	}
	return rowsAffected, rows.Err()
}
