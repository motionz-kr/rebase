package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeMongo implements mongoReader with canned data.
type fakeMongo struct {
	colls          []ports.CollectionInfo
	findResult     ports.MongoResult
	aggResult      ports.MongoResult
	count          int64
	fields         []ports.MongoField
	lastCollection string
	lastFilter     string
	lastSort       string
	lastLimit      int64
	lastPipeline   string
	lastSampleSize int64
}

func (f *fakeMongo) ListCollections(_ context.Context, _ domain.ConnectionProfile, _, _ string) ([]ports.CollectionInfo, error) {
	return f.colls, nil
}
func (f *fakeMongo) Find(_ context.Context, _ domain.ConnectionProfile, _, _, collection, filterJSON, _, sortJSON string, _, limit int64) (ports.MongoResult, error) {
	f.lastCollection = collection
	f.lastFilter = filterJSON
	f.lastSort = sortJSON
	f.lastLimit = limit
	return f.findResult, nil
}
func (f *fakeMongo) Aggregate(_ context.Context, _ domain.ConnectionProfile, _, _, collection, pipelineJSON string, limit int64) (ports.MongoResult, error) {
	f.lastCollection = collection
	f.lastPipeline = pipelineJSON
	f.lastLimit = limit
	return f.aggResult, nil
}
func (f *fakeMongo) CountDocuments(_ context.Context, _ domain.ConnectionProfile, _, _, collection, filterJSON string) (int64, error) {
	f.lastCollection = collection
	f.lastFilter = filterJSON
	return f.count, nil
}
func (f *fakeMongo) InferSchema(_ context.Context, _ domain.ConnectionProfile, _, _, collection string, sampleSize int64) ([]ports.MongoField, error) {
	f.lastCollection = collection
	f.lastSampleSize = sampleSize
	return f.fields, nil
}

func TestMongoRegistryExposesOnlyReadTools(t *testing.T) {
	reg := NewMongoRegistry(&fakeMongo{}, domainProfile(), "", "appdb")
	names := map[string]bool{}
	for _, s := range reg.Specs() {
		names[s.Name] = true
	}
	for _, want := range []string{"list_collections", "find", "count", "aggregate", "infer_schema"} {
		if !names[want] {
			t.Errorf("expected tool %q, got %v", want, names)
		}
	}
	if len(names) != 5 {
		t.Fatalf("mongo registry should expose exactly 5 read tools, got %v", names)
	}
	for _, bad := range []string{"insert", "insert_document", "replace_document", "delete_document", "create_index", "drop_index"} {
		if names[bad] {
			t.Errorf("mongo registry must NOT expose write tool %q", bad)
		}
	}
}

func TestMongoListCollections(t *testing.T) {
	conn := &fakeMongo{colls: []ports.CollectionInfo{{Name: "users"}, {Name: "orders"}}}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	out, err := reg.Dispatch(context.Background(), "list_collections", map[string]any{})
	if err != nil {
		t.Fatalf("list_collections: %v", err)
	}
	b, _ := json.Marshal(out)
	if string(b) != `["users","orders"]` {
		t.Errorf("list_collections = %s", b)
	}
}

func TestMongoFind(t *testing.T) {
	conn := &fakeMongo{findResult: ports.MongoResult{Documents: []string{`{"_id":1,"name":"alice"}`}, Total: 1}}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	out, err := reg.Dispatch(context.Background(), "find", map[string]any{
		"collection": "users", "filter": `{"active":true}`, "sort": `{"name":1}`,
	})
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if conn.lastCollection != "users" || conn.lastFilter != `{"active":true}` || conn.lastSort != `{"name":1}` {
		t.Errorf("find passed wrong args: coll=%q filter=%q sort=%q", conn.lastCollection, conn.lastFilter, conn.lastSort)
	}
	if conn.lastLimit != 50 {
		t.Errorf("find default limit should be 50, got %d", conn.lastLimit)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), "alice") {
		t.Errorf("find result wrong: %s", b)
	}
}

func TestMongoFindLimitCapped(t *testing.T) {
	conn := &fakeMongo{}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	if _, err := reg.Dispatch(context.Background(), "find", map[string]any{"collection": "users", "limit": float64(9999)}); err != nil {
		t.Fatalf("find: %v", err)
	}
	if conn.lastLimit != readQueryLimit {
		t.Errorf("find limit should be capped at %d, got %d", readQueryLimit, conn.lastLimit)
	}
}

func TestMongoCount(t *testing.T) {
	conn := &fakeMongo{count: 42}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	out, err := reg.Dispatch(context.Background(), "count", map[string]any{"collection": "users", "filter": `{"active":true}`})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if conn.lastFilter != `{"active":true}` {
		t.Errorf("count filter wrong: %q", conn.lastFilter)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), `"count":42`) {
		t.Errorf("count result wrong: %s", b)
	}
}

func TestMongoAggregateRejectsWriteStages(t *testing.T) {
	conn := &fakeMongo{}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	for _, pipeline := range []string{
		`[{"$out":"x"}]`,
		`[{"$match":{}},{"$merge":{"into":"y"}}]`,
	} {
		if _, err := reg.Dispatch(context.Background(), "aggregate", map[string]any{"collection": "users", "pipeline": pipeline}); err == nil {
			t.Errorf("aggregate should reject write pipeline %s", pipeline)
		}
		if conn.lastPipeline != "" {
			t.Errorf("aggregate must NOT call connector for write pipeline %s", pipeline)
		}
	}
}

func TestMongoAggregateAcceptsReadPipeline(t *testing.T) {
	conn := &fakeMongo{aggResult: ports.MongoResult{Documents: []string{`{"_id":"a","n":3}`}, Total: -1}}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	out, err := reg.Dispatch(context.Background(), "aggregate", map[string]any{
		"collection": "users", "pipeline": `[{"$group":{"_id":"$x"}}]`,
	})
	if err != nil {
		t.Fatalf("aggregate read pipeline: %v", err)
	}
	if conn.lastLimit != readQueryLimit {
		t.Errorf("aggregate should pass readQueryLimit, got %d", conn.lastLimit)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), `n`) || !containsSub(string(b), `total":-1`) {
		t.Errorf("aggregate result wrong: %s", b)
	}
}

func TestMongoInferSchema(t *testing.T) {
	conn := &fakeMongo{fields: []ports.MongoField{{Path: "name", Types: []string{"string"}, Presence: 1.0}}}
	reg := NewMongoRegistry(conn, domainProfile(), "", "appdb")
	out, err := reg.Dispatch(context.Background(), "infer_schema", map[string]any{"collection": "users"})
	if err != nil {
		t.Fatalf("infer_schema: %v", err)
	}
	if conn.lastSampleSize != 100 {
		t.Errorf("infer_schema default sampleSize should be 100, got %d", conn.lastSampleSize)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), "name") {
		t.Errorf("infer_schema result wrong: %s", b)
	}
}

func TestPipelineHasWriteStage(t *testing.T) {
	cases := []struct {
		json string
		want bool
	}{
		{`[{"$out":"x"}]`, true},
		{`[{"$match":{}},{"$merge":{"into":"y"}}]`, true},
		{`[{"$group":{"_id":"$x"}}]`, false},
		{`[{"$match":{"active":true}},{"$limit":10}]`, false},
		{`[]`, false},
		{`not json with $out inside`, true}, // malformed → conservative substring scan
		{`not json, only reads`, false},     // malformed, no write keyword
		{`[{"$project":{"out":1}}]`, false}, // "out" as field name, not "$out" stage
	}
	for _, c := range cases {
		if got := pipelineHasWriteStage(c.json); got != c.want {
			t.Errorf("pipelineHasWriteStage(%q) = %v, want %v", c.json, got, c.want)
		}
	}
}
