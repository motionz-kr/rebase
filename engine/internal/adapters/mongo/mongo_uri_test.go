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
