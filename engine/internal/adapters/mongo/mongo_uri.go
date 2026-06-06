package mongo

import (
	"fmt"
	"net/url"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

// BuildMongoURI returns the connection URI. An explicit ConnectionURI wins;
// otherwise it is built from host/port/credentials with authSource=admin.
func BuildMongoURI(p domain.ConnectionProfile, password string) string {
	if p.ConnectionURI != "" {
		return p.ConnectionURI
	}
	host := fmt.Sprintf("%s:%d", p.Host, p.Port)
	userinfo := ""
	if p.Username != "" {
		userinfo = url.QueryEscape(p.Username) + ":" + url.QueryEscape(password) + "@"
	}
	return fmt.Sprintf("mongodb://%s%s/?authSource=admin&serverSelectionTimeoutMS=5000", userinfo, host)
}
