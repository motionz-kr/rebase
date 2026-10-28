package sqlite

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestMetadataDatabaseSupportsReaderWriterOverlap(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "metadata ? #+.db")
	reader, err := OpenMetadataDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err := reader.ExecContext(ctx, "CREATE TABLE e2e_counter (id INT PRIMARY KEY, value INT); INSERT INTO e2e_counter VALUES (1, 0)"); err != nil {
		t.Fatal(err)
	}
	writer, err := OpenMetadataDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	tx, err := reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var value int
	if err := tx.QueryRowContext(ctx, "SELECT value FROM e2e_counter WHERE id=1").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.ExecContext(ctx, "UPDATE e2e_counter SET value=value+1 WHERE id=1"); err != nil {
		t.Fatalf("metadata write failed while another engine was reading: %v", err)
	}
	if err := tx.QueryRowContext(ctx, "SELECT value FROM e2e_counter WHERE id=1").Scan(&value); err != nil || value != 0 {
		t.Fatalf("snapshot: value=%d err=%v", value, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := reader.QueryRowContext(ctx, "SELECT value FROM e2e_counter WHERE id=1").Scan(&value); err != nil || value != 1 {
		t.Fatalf("committed value=%d err=%v", value, err)
	}
}

func TestMetadataDatabaseSerializesWritesAcrossEngines(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "metadata.db")
	first, err := OpenMetadataDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := first.ExecContext(ctx, "CREATE TABLE e2e_counter (value INT); INSERT INTO e2e_counter VALUES (0)"); err != nil {
		t.Fatal(err)
	}
	second, err := OpenMetadataDatabase(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	const count = 64
	errors := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		db := first
		if i%2 == 1 {
			db = second
		}
		go func() {
			defer wg.Done()
			_, err := db.ExecContext(ctx, "UPDATE e2e_counter SET value=value+1")
			errors <- err
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Errorf("parallel metadata write: %v", err)
		}
	}
	var value int
	if err := first.QueryRowContext(ctx, "SELECT value FROM e2e_counter").Scan(&value); err != nil || value != count {
		t.Fatalf("value=%d want=%d err=%v", value, count, err)
	}
}

func TestMetadataDatabaseConfiguresEveryConnectionAndRunsMigrations(t *testing.T) {
	ctx := context.Background()
	db, err := OpenMetadataDatabase(ctx, filepath.Join(t.TempDir(), "metadata.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if got := db.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("unbounded metadata pool: %d", got)
	}
	if err := NewMigrationRunner(db).Run([]Migration{{Version: 1, Name: "fixture", SQL: "CREATE TABLE e2e_migration (id INT)", Checksum: "fixture-v1"}}); err != nil {
		t.Fatal(err)
	}
	db.SetMaxIdleConns(0) // Force a replacement physical connection on each call.
	for i := 0; i < 2; i++ {
		var timeout int
		if err := db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&timeout); err != nil || timeout != 5000 {
			t.Fatalf("timeout=%d err=%v", timeout, err)
		}
		var mode string
		if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
			t.Fatalf("mode=%s err=%v", mode, err)
		}
	}
}
