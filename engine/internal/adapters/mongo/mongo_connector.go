package mongo

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

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
