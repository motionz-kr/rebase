package ports

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func VerifySQLConnectorIntrospection(t *testing.T, connector SQLConnector, p domain.ConnectionProfile, password string, targetDB string) {
	ctx := context.Background()

	dbs, err := connector.ListDatabases(ctx, p, password)
	if err != nil {
		t.Fatalf("failed to list databases: %v", err)
	}

	foundDB := false
	for _, db := range dbs {
		if db.Name == targetDB {
			foundDB = true
			break
		}
	}
	if !foundDB {
		t.Errorf("expected to find database %s in list: %v", targetDB, dbs)
	}

	tables, err := connector.ListTables(ctx, p, password, targetDB)
	if err != nil {
		t.Fatalf("failed to list tables for db %s: %v", targetDB, err)
	}

	if len(tables) == 0 {
		t.Logf("warning: no tables found in database %s, introspection verification might be limited", targetDB)
		return
	}

	firstTable := tables[0].Name
	desc, err := connector.DescribeTable(ctx, p, password, targetDB, firstTable)
	if err != nil {
		t.Fatalf("failed to describe table %s: %v", firstTable, err)
	}

	if len(desc.Columns) == 0 {
		t.Errorf("expected columns in table %s, got 0", firstTable)
	}

	for _, col := range desc.Columns {
		if col.Name == "" {
			t.Errorf("found column with empty name in table %s", firstTable)
		}
		if col.Type == "" {
			t.Errorf("found column %s with empty type in table %s", col.Name, firstTable)
		}
	}
}
