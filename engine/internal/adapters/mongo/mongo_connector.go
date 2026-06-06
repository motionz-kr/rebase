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
