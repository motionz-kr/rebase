package mongo

import (
	"context"
	"os"
	"strings"
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

func TestMongo_Find(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	res, err := c.Find(context.Background(), p, pw, testDB, "people", `{"age":{"$gte":30}}`, "", `{"age":1}`, 0, 10)
	if err != nil {
		t.Fatalf("Find: %v", err)
	}
	if len(res.Documents) == 0 {
		t.Fatal("expected docs")
	}
	if !strings.Contains(res.Documents[0], "\"name\"") {
		t.Fatalf("doc not ext-json: %s", res.Documents[0])
	}
	if res.Total < int64(len(res.Documents)) {
		t.Fatalf("Total should be the full match count, got %d", res.Total)
	}
}

func TestMongo_Aggregate(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	res, err := c.Aggregate(context.Background(), p, pw, testDB, "people",
		`[{"$group":{"_id":null,"count":{"$sum":1}}}]`, 0)
	if err != nil {
		t.Fatalf("Aggregate: %v", err)
	}
	if len(res.Documents) != 1 || !strings.Contains(res.Documents[0], "count") {
		t.Fatalf("agg result: %+v", res.Documents)
	}
}

func TestMongo_Count(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	n, err := c.CountDocuments(context.Background(), p, pw, testDB, "people", "")
	if err != nil {
		t.Fatalf("Count: %v", err)
	}
	if n <= 0 {
		t.Fatalf("expected >0, got %d", n)
	}
}

// extractID parses an ext-JSON document and returns its _id field re-serialized
// as an ext-JSON scalar (e.g. {"$oid":"..."}), suitable to feed back into
// Replace/Delete as idJSON.
func extractID(t *testing.T, docJSON string) string {
	t.Helper()
	var rawDoc bson.Raw
	if err := bson.UnmarshalExtJSON([]byte(docJSON), false, &rawDoc); err != nil {
		t.Fatalf("extractID unmarshal: %v", err)
	}
	idVal := rawDoc.Lookup("_id")
	wrap, err := bson.MarshalExtJSON(bson.D{{Key: "_id", Value: idVal}}, false, false)
	if err != nil {
		t.Fatalf("extractID marshal: %v", err)
	}
	// wrap is {"_id": <scalar>}; slice out just the scalar value.
	s := string(wrap)
	open := strings.Index(s, ":")
	if open < 0 {
		t.Fatalf("extractID: unexpected wrap %q", s)
	}
	scalar := strings.TrimSpace(s[open+1 : len(s)-1]) // drop trailing '}'
	return scalar
}

func TestMongo_InsertReplaceDelete(t *testing.T) {
	c, p, pw := newConn(t)
	seedMongo(t, p, pw)
	ctx := context.Background()
	// insert
	insID, err := c.InsertDocument(ctx, p, pw, testDB, "people", `{"name":"Zed","age":99}`)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if insID == "" {
		t.Fatal("expected inserted id")
	}
	// find it back
	res, err := c.Find(ctx, p, pw, testDB, "people", `{"name":"Zed"}`, "", "", 0, 10)
	if err != nil || len(res.Documents) != 1 {
		t.Fatalf("find Zed: %v / %d", err, len(res.Documents))
	}
	// extract its _id from the returned ext-json doc to drive replace/delete
	id := extractID(t, res.Documents[0])
	// replace
	if err := c.ReplaceDocument(ctx, p, pw, testDB, "people", id, `{"name":"Zed","age":100}`); err != nil {
		t.Fatalf("replace: %v", err)
	}
	res2, _ := c.Find(ctx, p, pw, testDB, "people", `{"name":"Zed"}`, "", "", 0, 10)
	if !strings.Contains(res2.Documents[0], "100") {
		t.Fatalf("replace didn't apply: %s", res2.Documents[0])
	}
	// delete
	if err := c.DeleteDocument(ctx, p, pw, testDB, "people", id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	res3, _ := c.CountDocuments(ctx, p, pw, testDB, "people", `{"name":"Zed"}`)
	if res3 != 0 {
		t.Fatalf("expected Zed deleted, count=%d", res3)
	}
}
