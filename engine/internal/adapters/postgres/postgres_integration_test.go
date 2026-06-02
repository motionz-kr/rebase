package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestPostgreSQLConnector_ExecuteBatch(t *testing.T) {
	connector := NewPostgreSQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{
		ID: "pg-batch-1", Name: "PG Local", Driver: "postgres",
		Host: "127.0.0.1", Port: 5432, Database: "postgres", Username: "postgres", TLSMode: "none",
	}
	pw := "postgres"

	exec := func(q string) error {
		_, err := connector.ExecuteQueryStream(ctx, p, pw, q, false,
			func(int64) {}, func([]string) error { return nil }, func([]any) error { return nil })
		return err
	}
	_ = exec("DROP TABLE IF EXISTS batch_test")
	if err := exec("CREATE TABLE batch_test (id INT PRIMARY KEY, v INT)"); err != nil {
		t.Fatalf("setup: %v", err)
	}
	defer exec("DROP TABLE IF EXISTS batch_test")

	_, failedIndex, err := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 10)",
		"INSERT INTO batch_test (id, v) VALUES (1, 20)",
	})
	if err == nil {
		t.Fatal("expected a duplicate-key error")
	}
	if failedIndex != 1 {
		t.Errorf("expected failedIndex 1, got %d", failedIndex)
	}
	_, fi2, err2 := connector.ExecuteBatch(ctx, p, pw, []string{
		"INSERT INTO batch_test (id, v) VALUES (1, 99)",
	})
	if err2 != nil || fi2 != -1 {
		t.Fatalf("rollback did not happen — id=1 still present (err=%v, fi=%d)", err2, fi2)
	}

	affected, fi3, err3 := connector.ExecuteBatch(ctx, p, pw, []string{
		"UPDATE batch_test SET v = 100 WHERE id = 1",
		"INSERT INTO batch_test (id, v) VALUES (2, 20)",
	})
	if err3 != nil || fi3 != -1 {
		t.Fatalf("expected success, got err=%v fi=%d", err3, fi3)
	}
	if affected != 2 {
		t.Errorf("expected rowsAffected 2, got %d", affected)
	}
}
