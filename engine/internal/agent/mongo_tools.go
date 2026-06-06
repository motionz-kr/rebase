package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// errAggregateWriteStage is returned when an aggregation pipeline contains a
// write stage ($out/$merge), which is forbidden in the read-only agent.
var errAggregateWriteStage = errors.New("aggregate write stages ($out/$merge) are not allowed")

// mongoReader is the read-only subset of ports.MongoConnector the agent tools
// need (kept small so tests can fake it, and so no write operation — insert,
// replace, delete, index mutation — can be reached from here).
type mongoReader interface {
	ListCollections(ctx context.Context, p domain.ConnectionProfile, password, database string) ([]ports.CollectionInfo, error)
	Find(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON, projectionJSON, sortJSON string, skip, limit int64) (ports.MongoResult, error)
	Aggregate(ctx context.Context, p domain.ConnectionProfile, password, database, collection, pipelineJSON string, limit int64) (ports.MongoResult, error)
	CountDocuments(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON string) (int64, error)
	InferSchema(ctx context.Context, p domain.ConnectionProfile, password, database, collection string, sampleSize int64) ([]ports.MongoField, error)
}

// pipelineHasWriteStage reports whether an aggregation pipeline contains a write
// stage ($out or $merge). It parses the pipeline JSON and inspects each stage's
// top-level key; if parsing fails it falls back to a conservative substring scan
// so a malformed-but-write pipeline is still rejected.
func pipelineHasWriteStage(pipelineJSON string) bool {
	var stages []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(pipelineJSON), &stages); err != nil {
		return strings.Contains(pipelineJSON, "$out") || strings.Contains(pipelineJSON, "$merge")
	}
	for _, stage := range stages {
		for key := range stage {
			if key == "$out" || key == "$merge" {
				return true
			}
		}
	}
	return false
}

// NewMongoRegistry builds the read-only tool set bound to one MongoDB
// connection profile and database. It exposes no write tools, and the aggregate
// tool rejects $out/$merge write stages.
func NewMongoRegistry(conn mongoReader, p domain.ConnectionProfile, password, database string) *Registry {
	r := &Registry{tools: map[string]Tool{}}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "list_collections",
			Description: "List collection names in the current MongoDB database (read-only).",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			colls, err := conn.ListCollections(ctx, p, password, database)
			if err != nil {
				return nil, err
			}
			names := make([]string, len(colls))
			for i, c := range colls {
				names[i] = c.Name
			}
			return names, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "find",
			Description: "Find documents in a collection matching a JSON filter, returning up to 200 (read-only).",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection": map[string]any{"type": "string"},
					"filter":     map[string]any{"type": "string", "description": "MongoDB query filter as a JSON object string"},
					"sort":       map[string]any{"type": "string", "description": "Sort spec as a JSON object string, e.g. {\"createdAt\":-1}"},
					"limit":      map[string]any{"type": "integer"},
				},
				"required": []string{"collection"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			limit := intArg(args, "limit", 50)
			if limit > readQueryLimit {
				limit = readQueryLimit
			}
			res, err := conn.Find(ctx, p, password, database, strArg(args, "collection"), strArg(args, "filter"), "", strArg(args, "sort"), 0, limit)
			if err != nil {
				return nil, err
			}
			return map[string]any{"documents": res.Documents, "total": res.Total}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "count",
			Description: "Count documents in a collection matching a JSON filter (read-only).",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection": map[string]any{"type": "string"},
					"filter":     map[string]any{"type": "string", "description": "MongoDB query filter as a JSON object string"},
				},
				"required": []string{"collection"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			n, err := conn.CountDocuments(ctx, p, password, database, strArg(args, "collection"), strArg(args, "filter"))
			if err != nil {
				return nil, err
			}
			return map[string]any{"count": n}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "aggregate",
			Description: "Run a read-only aggregation pipeline (a JSON array of stages) and return up to 200 documents. Write stages ($out/$merge) are rejected.",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection": map[string]any{"type": "string"},
					"pipeline":   map[string]any{"type": "string", "description": "Aggregation pipeline as a JSON array of stage objects"},
				},
				"required": []string{"collection", "pipeline"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			pipeline := strArg(args, "pipeline")
			if pipelineHasWriteStage(pipeline) {
				return nil, errAggregateWriteStage
			}
			res, err := conn.Aggregate(ctx, p, password, database, strArg(args, "collection"), pipeline, readQueryLimit)
			if err != nil {
				return nil, err
			}
			return map[string]any{"documents": res.Documents, "total": res.Total}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "infer_schema",
			Description: "Infer a collection's field schema (path, types, presence) by sampling documents (read-only).",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"collection": map[string]any{"type": "string"},
					"sampleSize": map[string]any{"type": "integer"},
				},
				"required": []string{"collection"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return conn.InferSchema(ctx, p, password, database, strArg(args, "collection"), intArg(args, "sampleSize", 100))
		},
	})

	return r
}
