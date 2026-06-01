package mysql

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestMySQLConnector_Integration(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	err := connector.TestConnection(ctx, p, "password1!")
	if err != nil {
		t.Fatalf("failed to connect to local MySQL: %v", err)
	}
}

func TestMySQLConnector_ExecuteQueryStream(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	var headers []string
	var rows [][]any

	rowsAffected, err := connector.ExecuteQueryStream(
		ctx, p, "password1!",
		"SELECT SCHEMA_NAME FROM information_schema.schemata LIMIT 2",
		false,
		func(sessionID int64) {},
		func(cols []string) error {
			headers = cols
			return nil
		},
		func(row []any) error {
			rows = append(rows, row)
			return nil
		},
	)

	if err != nil {
		t.Fatalf("failed to execute query stream: %v", err)
	}

	if len(headers) != 1 || headers[0] != "SCHEMA_NAME" {
		t.Errorf("unexpected headers: %v", headers)
	}

	if len(rows) == 0 {
		t.Errorf("expected at least one row, got 0")
	}

	if rowsAffected != int64(len(rows)) {
		t.Errorf("rowsAffected (%d) does not match len(rows) (%d)", rowsAffected, len(rows))
	}
}

func TestMySQLConnector_Cancellation(t *testing.T) {
	connector := NewMySQLConnector()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p := domain.ConnectionProfile{
		ID:        "mysql-integration-1",
		Name:      "MySQL Local",
		Driver:    "mysql",
		Host:      "127.0.0.1",
		Port:      3306,
		Database:  "information_schema",
		Username:  "root",
		TLSMode:   "none",
	}

	sessionChan := make(chan int64, 1)

	go func() {
		_, _ = connector.ExecuteQueryStream(
			ctx, p, "password1!",
			"SELECT SLEEP(5)",
			false,
			func(sessionID int64) {
				sessionChan <- sessionID
			},
			func(cols []string) error { return nil },
			func(row []any) error { return nil },
		)
	}()

	select {
	case sessionID := <-sessionChan:
		time.Sleep(100 * time.Millisecond)
		err := connector.CancelSession(context.Background(), p, "password1!", sessionID)
		if err != nil {
			t.Fatalf("failed to cancel session: %v", err)
		}
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for query session to start")
	}
}

