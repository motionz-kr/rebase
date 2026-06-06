package mongo

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestBuildMongoURI_Structured(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", Host: "h", Port: 27017, Username: "u"}
	got := BuildMongoURI(p, "p@ss")
	if !strings.HasPrefix(got, "mongodb://u:p%40ss@h:27017/") || !strings.Contains(got, "authSource=admin") {
		t.Fatalf("got %q", got)
	}
}
func TestBuildMongoURI_Override(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", ConnectionURI: "mongodb+srv://a/b"}
	if BuildMongoURI(p, "") != "mongodb+srv://a/b" {
		t.Fatal("uri override should win")
	}
}
func TestBuildMongoURI_NoAuth(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", Host: "h", Port: 27017}
	if strings.Contains(BuildMongoURI(p, ""), "@") {
		t.Fatal("no userinfo when username empty")
	}
}

func TestIDFilter(t *testing.T) {
	// a plain scalar id is accepted
	if _, err := idFilter(`123`); err != nil {
		t.Fatalf("scalar id should be valid: %v", err)
	}
	if _, err := idFilter(`{"$oid":"66230000000000000000000a"}`); err != nil {
		t.Fatalf("oid id should be valid: %v", err)
	}
	// a legitimate compound _id (no $ keys) is accepted
	if _, err := idFilter(`{"a":1,"b":2}`); err != nil {
		t.Fatalf("compound id should be valid: %v", err)
	}
	// an operator-valued _id is rejected (would widen the match)
	if _, err := idFilter(`{"$gt":0}`); err == nil {
		t.Fatal("operator-valued _id should be rejected")
	}
	// a comma-injection that breaks out of the wrapper is rejected (len != 1)
	if _, err := idFilter(`1, "x": {"$gt": 0}`); err == nil {
		t.Fatal("multi-field _id injection should be rejected")
	}
}
