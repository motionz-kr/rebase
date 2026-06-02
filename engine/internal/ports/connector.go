package ports

import (
	"context"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type DBConnector interface {
	TestConnection(ctx context.Context, profile domain.ConnectionProfile, password string) error
}

type DatabaseInfo struct {
	Name string `json:"name"`
}

type TableInfo struct {
	Name string `json:"name"`
}

type ColumnInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primaryKey"`
}

type TableDescription struct {
	Columns []ColumnInfo `json:"columns"`
}

// ColumnRef is a flat (table, column, type) row used to build editor
// autocompletion for a whole database in a single query.
type ColumnRef struct {
	Table  string `json:"table"`
	Column string `json:"column"`
	Type   string `json:"type"`
}

// ForeignKey describes a single foreign-key constraint column binding.
type ForeignKey struct {
	Column    string `json:"column"`
	RefTable  string `json:"refTable"`
	RefColumn string `json:"refColumn"`
}

type SQLConnector interface {
	DBConnector
	ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]DatabaseInfo, error)
	ListTables(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]TableInfo, error)
	ListViews(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]TableInfo, error)
	GetViewDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, view string) (string, error)
	DescribeTable(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (TableDescription, error)
	GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (string, error)
	ListColumns(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ColumnRef, error)
	ListForeignKeys(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) ([]ForeignKey, error)
	ExecuteQueryStream(ctx context.Context, p domain.ConnectionProfile, password string, query string, readOnly bool, onSessionStart func(sessionID int64), onHeader func(columns []string) error, onRow func(row []any) error) (int64, error)
	ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (rowsAffected int64, failedIndex int, err error)
	CancelSession(ctx context.Context, p domain.ConnectionProfile, password string, sessionID int64) error
}

type RedisKeyspaceInfo struct {
	Keys   []string `json:"keys"`
	Cursor uint64   `json:"cursor"`
}

type RedisValueInfo struct {
	Type  string `json:"type"`
	Value string `json:"value"`
	// TTL in seconds: -1 means the key has no expiry, -2 means the key does
	// not exist. Use Exists to disambiguate rather than comparing TTL.
	TTL int64 `json:"ttl"`
	// Exists is false when the key is absent (Redis TYPE returned "none").
	Exists bool `json:"exists"`
	// Truncated is true when a collection value was capped to a preview window.
	Truncated bool `json:"truncated"`
}

type RedisConnector interface {
	DBConnector
	ScanKeys(ctx context.Context, p domain.ConnectionProfile, password string, pattern string, cursor uint64, count int64) (RedisKeyspaceInfo, error)
	GetKeyValue(ctx context.Context, p domain.ConnectionProfile, password string, key string) (RedisValueInfo, error)
}
