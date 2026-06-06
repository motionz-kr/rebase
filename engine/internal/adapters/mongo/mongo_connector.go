package mongo

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	driver "go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// MongoConnector is a stateless adapter that opens a fresh client per call.
type MongoConnector struct{}

// NewMongoConnector returns a MongoConnector.
func NewMongoConnector() *MongoConnector {
	return &MongoConnector{}
}

// Compile-time assertion that MongoConnector satisfies the port interface.
var _ ports.MongoConnector = (*MongoConnector)(nil)

// client connects to MongoDB using the profile-derived URI. The caller owns the
// returned client and must Disconnect it.
func (c *MongoConnector) client(p domain.ConnectionProfile, password string) (*driver.Client, error) {
	client, err := driver.Connect(options.Client().ApplyURI(BuildMongoURI(p, password)))
	if err != nil {
		return nil, normalizeError(err)
	}
	return client, nil
}

// TestConnection connects and pings the server.
func (c *MongoConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	client, err := c.client(p, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)
	if err := client.Ping(ctx, nil); err != nil {
		return normalizeError(err)
	}
	return nil
}

// ListDatabases returns the names of all databases on the server.
func (c *MongoConnector) ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]ports.DatabaseInfo, error) {
	client, err := c.client(p, password)
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(ctx)

	names, err := client.ListDatabaseNames(ctx, bson.D{})
	if err != nil {
		return nil, normalizeError(err)
	}
	sort.Strings(names)
	out := make([]ports.DatabaseInfo, 0, len(names))
	for _, n := range names {
		out = append(out, ports.DatabaseInfo{Name: n})
	}
	return out, nil
}

// ListCollections returns the collection names within a database, sorted.
func (c *MongoConnector) ListCollections(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.CollectionInfo, error) {
	client, err := c.client(p, password)
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(ctx)

	names, err := client.Database(database).ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, normalizeError(err)
	}
	sort.Strings(names)
	out := make([]ports.CollectionInfo, 0, len(names))
	for _, n := range names {
		out = append(out, ports.CollectionInfo{Name: n})
	}
	return out, nil
}

// Find returns matching documents as relaxed Extended-JSON strings. Total is the
// full match count (ignoring skip/limit) so callers can paginate.
func (c *MongoConnector) Find(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON, projectionJSON, sortJSON string, skip, limit int64) (ports.MongoResult, error) {
	client, err := c.client(p, password)
	if err != nil {
		return ports.MongoResult{}, err
	}
	defer client.Disconnect(ctx)

	filter := bson.D{}
	if filterJSON != "" {
		if err := bson.UnmarshalExtJSON([]byte(filterJSON), false, &filter); err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
	}

	opts := options.Find()
	if sortJSON != "" {
		var sort bson.D
		if err := bson.UnmarshalExtJSON([]byte(sortJSON), false, &sort); err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
		opts.SetSort(sort)
	}
	if projectionJSON != "" {
		var proj bson.D
		if err := bson.UnmarshalExtJSON([]byte(projectionJSON), false, &proj); err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
		opts.SetProjection(proj)
	}
	if skip > 0 {
		opts.SetSkip(skip)
	}
	if limit > 0 {
		opts.SetLimit(limit)
	}

	coll := client.Database(database).Collection(collection)
	cur, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return ports.MongoResult{}, normalizeError(err)
	}
	defer cur.Close(ctx)

	var docs []string
	for cur.Next(ctx) {
		ext, err := bson.MarshalExtJSON(cur.Current, false, false)
		if err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
		docs = append(docs, string(ext))
	}
	if err := cur.Err(); err != nil {
		return ports.MongoResult{}, normalizeError(err)
	}

	total, err := coll.CountDocuments(ctx, filter)
	if err != nil {
		return ports.MongoResult{}, normalizeError(err)
	}
	return ports.MongoResult{Documents: docs, Total: total}, nil
}

// Aggregate runs a pipeline (a JSON array) and returns documents as relaxed
// Extended-JSON strings. Total is -1 (not counted). When limit>0 the result
// slice is capped to limit entries.
func (c *MongoConnector) Aggregate(ctx context.Context, p domain.ConnectionProfile, password, database, collection, pipelineJSON string, limit int64) (ports.MongoResult, error) {
	client, err := c.client(p, password)
	if err != nil {
		return ports.MongoResult{}, err
	}
	defer client.Disconnect(ctx)

	pipeline := bson.A{}
	if pipelineJSON != "" {
		if err := bson.UnmarshalExtJSON([]byte(pipelineJSON), false, &pipeline); err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
	}

	coll := client.Database(database).Collection(collection)
	cur, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		return ports.MongoResult{}, normalizeError(err)
	}
	defer cur.Close(ctx)

	var docs []string
	for cur.Next(ctx) {
		if limit > 0 && int64(len(docs)) >= limit {
			break
		}
		ext, err := bson.MarshalExtJSON(cur.Current, false, false)
		if err != nil {
			return ports.MongoResult{}, normalizeError(err)
		}
		docs = append(docs, string(ext))
	}
	if err := cur.Err(); err != nil {
		return ports.MongoResult{}, normalizeError(err)
	}
	return ports.MongoResult{Documents: docs, Total: -1}, nil
}

// CountDocuments returns the number of documents matching filterJSON (empty →
// all documents).
func (c *MongoConnector) CountDocuments(ctx context.Context, p domain.ConnectionProfile, password, database, collection, filterJSON string) (int64, error) {
	client, err := c.client(p, password)
	if err != nil {
		return 0, err
	}
	defer client.Disconnect(ctx)

	filter := bson.D{}
	if filterJSON != "" {
		if err := bson.UnmarshalExtJSON([]byte(filterJSON), false, &filter); err != nil {
			return 0, normalizeError(err)
		}
	}

	n, err := client.Database(database).Collection(collection).CountDocuments(ctx, filter)
	if err != nil {
		return 0, normalizeError(err)
	}
	return n, nil
}

// InsertDocument inserts a single document (ext-JSON) and returns the inserted
// _id as an ext-JSON scalar (e.g. {"$oid":"..."} for an ObjectId).
func (c *MongoConnector) InsertDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, documentJSON string) (string, error) {
	client, err := c.client(p, password)
	if err != nil {
		return "", err
	}
	defer client.Disconnect(ctx)

	var doc bson.D
	if err := bson.UnmarshalExtJSON([]byte(documentJSON), false, &doc); err != nil {
		return "", normalizeError(err)
	}

	coll := client.Database(database).Collection(collection)
	res, err := coll.InsertOne(ctx, doc)
	if err != nil {
		return "", normalizeError(err)
	}

	// Marshal {"_id": <id>} then slice out just the scalar value so the caller
	// gets an ext-JSON scalar consistent with what extractID produces.
	wrap, err := bson.MarshalExtJSON(bson.D{{Key: "_id", Value: res.InsertedID}}, false, false)
	if err != nil {
		return "", normalizeError(err)
	}
	s := string(wrap)
	idx := strings.Index(s, ":")
	if idx < 0 {
		return s, nil
	}
	return strings.TrimSpace(s[idx+1 : len(s)-1]), nil
}

// ReplaceDocument replaces the document whose _id matches idJSON (an ext-JSON
// scalar) with the given ext-JSON document.
func (c *MongoConnector) ReplaceDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, idJSON, documentJSON string) error {
	client, err := c.client(p, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)

	var doc bson.D
	if err := bson.UnmarshalExtJSON([]byte(documentJSON), false, &doc); err != nil {
		return normalizeError(err)
	}

	var wrap bson.D
	if err := bson.UnmarshalExtJSON([]byte(`{"_id":`+idJSON+`}`), false, &wrap); err != nil {
		return normalizeError(err)
	}
	filter := bson.D{{Key: "_id", Value: wrap[0].Value}}

	coll := client.Database(database).Collection(collection)
	if _, err := coll.ReplaceOne(ctx, filter, doc); err != nil {
		return normalizeError(err)
	}
	return nil
}

// DeleteDocument deletes the document whose _id matches idJSON (an ext-JSON
// scalar).
func (c *MongoConnector) DeleteDocument(ctx context.Context, p domain.ConnectionProfile, password, database, collection, idJSON string) error {
	client, err := c.client(p, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)

	var wrap bson.D
	if err := bson.UnmarshalExtJSON([]byte(`{"_id":`+idJSON+`}`), false, &wrap); err != nil {
		return normalizeError(err)
	}
	filter := bson.D{{Key: "_id", Value: wrap[0].Value}}

	coll := client.Database(database).Collection(collection)
	if _, err := coll.DeleteOne(ctx, filter); err != nil {
		return normalizeError(err)
	}
	return nil
}

// ListIndexes returns the indexes defined on a collection.
func (c *MongoConnector) ListIndexes(ctx context.Context, p domain.ConnectionProfile, password, database, collection string) ([]ports.MongoIndex, error) {
	client, err := c.client(p, password)
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(ctx)

	iv := client.Database(database).Collection(collection).Indexes()
	cur, err := iv.List(ctx)
	if err != nil {
		return nil, normalizeError(err)
	}
	defer cur.Close(ctx)

	var out []ports.MongoIndex
	for cur.Next(ctx) {
		var idx bson.M
		if err := cur.Decode(&idx); err != nil {
			return nil, normalizeError(err)
		}
		var mi ports.MongoIndex
		if name, ok := idx["name"].(string); ok {
			mi.Name = name
		}
		if key, ok := idx["key"]; ok {
			if kb, err := bson.MarshalExtJSON(key, false, false); err == nil {
				mi.Keys = string(kb)
			}
		}
		mi.Unique = idx["unique"] == true
		out = append(out, mi)
	}
	if err := cur.Err(); err != nil {
		return nil, normalizeError(err)
	}
	return out, nil
}

// CreateIndex creates an index from a JSON key spec (e.g. {"age":-1}). When name
// is non-empty it is used as the index name; unique enforces a uniqueness
// constraint.
func (c *MongoConnector) CreateIndex(ctx context.Context, p domain.ConnectionProfile, password, database, collection, keysJSON string, unique bool, name string) error {
	client, err := c.client(p, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)

	var keys bson.D
	if err := bson.UnmarshalExtJSON([]byte(keysJSON), false, &keys); err != nil {
		return normalizeError(err)
	}

	opts := options.Index().SetUnique(unique)
	if name != "" {
		opts.SetName(name)
	}
	model := driver.IndexModel{Keys: keys, Options: opts}
	iv := client.Database(database).Collection(collection).Indexes()
	if _, err := iv.CreateOne(ctx, model); err != nil {
		return normalizeError(err)
	}
	return nil
}

// DropIndex drops the named index from a collection.
func (c *MongoConnector) DropIndex(ctx context.Context, p domain.ConnectionProfile, password, database, collection, name string) error {
	client, err := c.client(p, password)
	if err != nil {
		return err
	}
	defer client.Disconnect(ctx)

	iv := client.Database(database).Collection(collection).Indexes()
	if err := iv.DropOne(ctx, name); err != nil {
		return normalizeError(err)
	}
	return nil
}

// InferSchema samples documents and reports each field's observed BSON types and
// presence (the fraction of sampled docs containing the field). It inspects
// top-level fields plus one level of nesting (parent.child for sub-documents).
// Results are sorted by presence descending then path ascending.
func (c *MongoConnector) InferSchema(ctx context.Context, p domain.ConnectionProfile, password, database, collection string, sampleSize int64) ([]ports.MongoField, error) {
	client, err := c.client(p, password)
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(ctx)

	coll := client.Database(database).Collection(collection)
	cur, err := coll.Aggregate(ctx, bson.A{
		bson.D{{Key: "$sample", Value: bson.D{{Key: "size", Value: sampleSize}}}},
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	defer cur.Close(ctx)

	types := map[string]map[string]bool{} // path -> set of type names
	counts := map[string]int{}            // path -> presence count
	total := 0

	record := func(path string, v interface{}) {
		if types[path] == nil {
			types[path] = map[string]bool{}
		}
		types[path][bsonTypeName(v)] = true
		counts[path]++
	}

	for cur.Next(ctx) {
		var doc bson.M
		if err := cur.Decode(&doc); err != nil {
			return nil, normalizeError(err)
		}
		total++
		for k, v := range doc {
			record(k, v)
			if sub, ok := v.(bson.M); ok {
				for ck, cv := range sub {
					record(k+"."+ck, cv)
				}
			}
		}
	}
	if err := cur.Err(); err != nil {
		return nil, normalizeError(err)
	}

	out := make([]ports.MongoField, 0, len(counts))
	for path, n := range counts {
		ts := make([]string, 0, len(types[path]))
		for t := range types[path] {
			ts = append(ts, t)
		}
		sort.Strings(ts)
		presence := 0.0
		if total > 0 {
			presence = float64(n) / float64(total)
		}
		out = append(out, ports.MongoField{Path: path, Types: ts, Presence: presence})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Presence != out[j].Presence {
			return out[i].Presence > out[j].Presence
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// bsonTypeName maps a Go value decoded from BSON to a friendly BSON type name.
func bsonTypeName(v interface{}) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "bool"
	case int32, int64, int:
		return "int"
	case float64, float32:
		return "double"
	case bson.ObjectID:
		return "objectId"
	case bson.DateTime, time.Time:
		return "date"
	case bson.M, bson.D:
		return "object"
	case bson.A, []interface{}:
		return "array"
	default:
		return fmt.Sprintf("%T", v)
	}
}

// normalizeError maps common low-level driver errors to friendly messages.
func normalizeError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	low := strings.ToLower(msg)
	switch {
	case strings.Contains(low, "authentication failed"),
		strings.Contains(low, "auth error"),
		strings.Contains(low, "unauthorized"):
		return errors.New("authentication failed: check username and password")
	case strings.Contains(low, "connection refused"),
		strings.Contains(low, "no reachable servers"),
		strings.Contains(low, "server selection timeout"),
		strings.Contains(low, "connection() error"):
		return errors.New("could not reach MongoDB server: check host, port, and that the server is running")
	default:
		return fmt.Errorf("mongodb: %w", err)
	}
}
