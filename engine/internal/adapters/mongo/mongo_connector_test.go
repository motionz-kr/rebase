package mongo

import (
	"context"
	"os"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
	driver "go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

const testDB = "rebase_test"

// mongoProfile reads MONGO_TEST_URI and skips when unset. The URI carries auth,
// so the returned password is empty.
func mongoProfile(t *testing.T) (domain.ConnectionProfile, string) {
	t.Helper()
	uri := os.Getenv("MONGO_TEST_URI")
	if uri == "" {
		t.Skip("MONGO_TEST_URI not set; skipping live MongoDB integration test")
	}
	return domain.ConnectionProfile{Driver: "mongodb", ConnectionURI: uri}, ""
}

// newConn returns a connector plus a live profile (skips when no env).
func newConn(t *testing.T) (*MongoConnector, domain.ConnectionProfile, string) {
	t.Helper()
	p, pw := mongoProfile(t)
	return NewMongoConnector(), p, pw
}

// seedMongo drops and recreates rebase_test with people + orders collections
// and an index on people.name.
func seedMongo(t *testing.T, p domain.ConnectionProfile, pw string) {
	t.Helper()
	ctx := context.Background()
	client, err := driver.Connect(options.Client().ApplyURI(BuildMongoURI(p, pw)))
	if err != nil {
		t.Fatalf("seed connect: %v", err)
	}
	defer client.Disconnect(ctx)

	db := client.Database(testDB)
	if err := db.Drop(ctx); err != nil {
		t.Fatalf("seed drop: %v", err)
	}
	people := db.Collection("people")
	if _, err := people.InsertMany(ctx, []any{
		bson.D{{Key: "name", Value: "Alice"}, {Key: "age", Value: 30}},
		bson.D{{Key: "name", Value: "Bob"}, {Key: "age", Value: 25}},
		bson.D{{Key: "name", Value: "Carol"}, {Key: "age", Value: 41}},
	}); err != nil {
		t.Fatalf("seed people: %v", err)
	}
	orders := db.Collection("orders")
	if _, err := orders.InsertMany(ctx, []any{
		bson.D{{Key: "sku", Value: "A1"}, {Key: "qty", Value: 2}},
		bson.D{{Key: "sku", Value: "B2"}, {Key: "qty", Value: 5}},
	}); err != nil {
		t.Fatalf("seed orders: %v", err)
	}
	if _, err := people.Indexes().CreateOne(ctx, driver.IndexModel{
		Keys: bson.D{{Key: "name", Value: 1}},
	}); err != nil {
		t.Fatalf("seed index: %v", err)
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

func TestMongo_TestConnection(t *testing.T) {
	c, p, pw := newConn(t)
	if err := c.TestConnection(context.Background(), p, pw); err != nil {
		t.Fatal(err)
	}
}

func TestMongo_ListDatabases(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	dbs, err := c.ListDatabases(context.Background(), p, pw)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, d := range dbs {
		names = append(names, d.Name)
	}
	if !contains(names, testDB) {
		t.Fatalf("expected %q in %v", testDB, names)
	}
}

func TestMongo_ListCollections(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	cols, err := c.ListCollections(context.Background(), p, pw, testDB)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, col := range cols {
		names = append(names, col.Name)
	}
	if !contains(names, "people") || !contains(names, "orders") {
		t.Fatalf("expected people+orders in %v", names)
	}
}
