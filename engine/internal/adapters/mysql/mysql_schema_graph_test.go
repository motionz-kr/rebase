package mysql

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func ergProfile() domain.ConnectionProfile {
	return domain.ConnectionProfile{
		ID:       "mysql-schema-graph-1",
		Name:     "MySQL Schema Graph",
		Driver:   "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "devdb",
		Username: "root",
		TLSMode:  "none",
	}
}

func ergFindTable(ts []ports.SchemaGraphTable, n string) *ports.SchemaGraphTable {
	for i := range ts {
		if ts[i].Name == n {
			return &ts[i]
		}
	}
	return nil
}

func ergFindCol(cs []ports.ColumnInfo, n string) *ports.ColumnInfo {
	for i := range cs {
		if cs[i].Name == n {
			return &cs[i]
		}
	}
	return nil
}

func TestMySQLGetSchemaGraph(t *testing.T) {
	c := NewMySQLConnector()
	p := ergProfile()
	pw := "password1!"
	ctx := context.Background()

	exec := func(sql string) {
		if _, _, err := c.ExecuteBatch(ctx, p, pw, []string{sql}); err != nil {
			t.Fatalf("setup %q: %v", sql, err)
		}
	}
	exec("DROP TABLE IF EXISTS erg_orders")
	exec("DROP TABLE IF EXISTS erg_users")
	exec("CREATE TABLE erg_users (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)")
	exec("CREATE TABLE erg_orders (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES erg_users(id))")
	defer func() {
		exec("DROP TABLE IF EXISTS erg_orders")
		exec("DROP TABLE IF EXISTS erg_users")
	}()

	g, err := c.GetSchemaGraph(ctx, p, pw, "devdb")
	if err != nil {
		t.Fatalf("GetSchemaGraph: %v", err)
	}

	users := ergFindTable(g.Tables, "erg_users")
	if users == nil {
		t.Fatal("erg_users missing from graph")
	}
	idCol := ergFindCol(users.Columns, "id")
	if idCol == nil || !idCol.PrimaryKey {
		t.Errorf("erg_users.id should be a PK column: %+v", users.Columns)
	}
	nameCol := ergFindCol(users.Columns, "name")
	if nameCol == nil || nameCol.Nullable {
		t.Errorf("erg_users.name should be NOT NULL: %+v", users.Columns)
	}

	var fk *ports.SchemaGraphFK
	for i := range g.ForeignKeys {
		if g.ForeignKeys[i].FromTable == "erg_orders" && g.ForeignKeys[i].FromColumn == "user_id" {
			fk = &g.ForeignKeys[i]
		}
	}
	if fk == nil || fk.ToTable != "erg_users" || fk.ToColumn != "id" {
		t.Errorf("expected erg_orders.user_id -> erg_users.id, got %+v", g.ForeignKeys)
	}
}
