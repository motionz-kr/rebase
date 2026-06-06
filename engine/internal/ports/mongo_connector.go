package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type CollectionInfo struct {
	Name string `json:"name"`
}

// MongoResult carries documents as relaxed Extended-JSON strings.
type MongoResult struct {
	Documents []string `json:"documents"`
	Total     int64    `json:"total"` // -1 when not counted (e.g. aggregate)
}

type MongoIndex struct {
	Name   string `json:"name"`
	Keys   string `json:"keys"` // JSON, e.g. {"name":1}
	Unique bool   `json:"unique"`
}

type MongoField struct {
	Path     string   `json:"path"`
	Types    []string `json:"types"`
	Presence float64  `json:"presence"` // fraction of sampled docs containing this field
}

type MongoConnector interface {
	TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error
	ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]DatabaseInfo, error)
	ListCollections(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]CollectionInfo, error)
	Find(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON, projectionJSON, sortJSON string, skip, limit int64) (MongoResult, error)
	Aggregate(ctx context.Context, p domain.ConnectionProfile, password, database, collection, pipelineJSON string, limit int64) (MongoResult, error)
	CountDocuments(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON string) (int64, error)
	InsertDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, documentJSON string) (string, error)
	ReplaceDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, idJSON, documentJSON string) error
	DeleteDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, idJSON string) error
	ListIndexes(ctx context.Context, p domain.ConnectionProfile, password, database, collection string) ([]MongoIndex, error)
	CreateIndex(ctx context.Context, p domain.ConnectionProfile, password, database, collection, keysJSON string, unique bool, name string) error
	DropIndex(ctx context.Context, p domain.ConnectionProfile, password, database, collection, name string) error
	InferSchema(ctx context.Context, p domain.ConnectionProfile, password, database, collection string, sampleSize int64) ([]MongoField, error)
}
