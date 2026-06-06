//go:build integration

package http

import (
	"context"
	"database/sql"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/analyzer"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "github.com/go-sql-driver/mysql"
)

const testDSN = "root:password1!@tcp(127.0.0.1:3306)/devdb?parseTime=true&multiStatements=true"
const testPassword = "password1!"

func testProfile() domain.ConnectionProfile {
	return domain.ConnectionProfile{
		Driver: "mysql", Host: "127.0.0.1", Port: 3306,
		Database: "devdb", Username: "root", TLSMode: "none",
	}
}

func TestEnrichReport_DeleteCountAndRollback(t *testing.T) {
	db, err := sql.Open("mysql", testDSN)
	if err != nil {
		t.Skipf("no mysql: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Skipf("mysql unreachable: %v", err)
	}
	ctx := context.Background()
	db.ExecContext(ctx, "DROP TABLE IF EXISTS erg_safe_test")
	if _, err := db.ExecContext(ctx, "CREATE TABLE erg_safe_test (id INT PRIMARY KEY, name VARCHAR(50), hospitalId INT)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	defer db.ExecContext(ctx, "DROP TABLE IF EXISTS erg_safe_test")
	if _, err := db.ExecContext(ctx, "INSERT INTO erg_safe_test VALUES (1,'a',153),(2,'b',153),(3,'c',999)"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	h := &QueryHandler{}
	connector := mysql.NewMySQLConnector()
	report := analyzer.Analyze("DELETE FROM erg_safe_test WHERE hospitalId = 153", []string{"hospitalId"})
	resp := assembleStaticReport(report)
	h.enrichReport(ctx, connector, testProfile(), testPassword, "devdb", report, &resp)

	if resp.AffectedRows == nil || *resp.AffectedRows != 2 {
		t.Fatalf("affectedRows: %v", resp.AffectedRows)
	}
	if resp.RollbackSQL == "" {
		t.Fatal("expected rollback SQL for DELETE with PK")
	}
	if len(resp.PreviewRows) != 2 {
		t.Errorf("expected 2 preview rows, got %d", len(resp.PreviewRows))
	}
}
