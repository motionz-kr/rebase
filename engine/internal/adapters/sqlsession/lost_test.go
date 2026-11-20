package sqlsession

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// fakeServer is a scripted driver backend: every statement is recorded, and once
// `down` is set statements fail with it without reaching a "server".
type fakeServer struct {
	mu   sync.Mutex
	down error
	log  []string
}

func (f *fakeServer) kill(err error) {
	f.mu.Lock()
	f.down = err
	f.mu.Unlock()
}

func (f *fakeServer) statements() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fakeServer) run(query string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down != nil {
		return f.down
	}
	f.log = append(f.log, query)
	return nil
}

type fakeConnector struct{ server *fakeServer }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &fakeConn{server: c.server}, nil
}
func (c fakeConnector) Driver() driver.Driver { return nil }

type fakeConn struct{ server *fakeServer }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unsupported") }
func (c *fakeConn) Close() error                        { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)           { return nil, errors.New("unsupported") }
func (c *fakeConn) Ping(context.Context) error          { return nil }
func (c *fakeConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if err := c.server.run(query); err != nil {
		return nil, err
	}
	return driver.RowsAffected(0), nil
}
func (c *fakeConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if err := c.server.run(query); err != nil {
		return nil, err
	}
	return &fakeRows{}, nil
}

type fakeRows struct{ done bool }

func (r *fakeRows) Columns() []string { return []string{"x"} }
func (r *fakeRows) Close() error      { return nil }
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = int64(1)
	return nil
}

var errDriverDropped = errors.New("fake driver: invalid connection")

func openFakeSession(t *testing.T, opts Options) (*Manager, *fakeServer, string) {
	t.Helper()
	server := &fakeServer{}
	manager := NewManager(time.Hour)
	t.Cleanup(manager.Shutdown)
	id, err := manager.Open(context.Background(), "owner", "db", sql.OpenDB(fakeConnector{server}), false, opts)
	if err != nil {
		t.Fatal(err)
	}
	return manager, server, id
}

func mustState(t *testing.T, manager *Manager, id string) string {
	t.Helper()
	state, err := manager.State("owner", id)
	if err != nil {
		t.Fatalf("State returned error: %v", err)
	}
	return state
}

func run(manager *Manager, id, query string) error {
	lease, err := manager.Query(context.Background(), "owner", "db", id, false, query)
	if err != nil {
		return err
	}
	defer lease.Close()
	for lease.Rows.Next() {
	}
	return lease.Rows.Err()
}

func TestLostConnectionWhileIdleReportsLostAndNeverTouchesTheConnectionAgain(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{AutoCommit: true, IsConnectionLost: func(err error) bool {
		return errors.Is(err, errDriverDropped)
	}})
	if err := run(manager, id, "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	server.kill(errDriverDropped)
	if err := run(manager, id, "SELECT 2"); !errors.Is(err, errDriverDropped) {
		t.Fatalf("the failing run keeps the driver error for the transport to translate, got %v", err)
	}
	if got := mustState(t, manager, id); got != StateLost {
		t.Fatalf("state = %q, want %q", got, StateLost)
	}

	// The connection is never retried or replayed once classified as lost.
	server.kill(nil)
	before := server.statements()
	if err := run(manager, id, "SELECT 3"); !errors.Is(err, ErrConnectionLost) {
		t.Fatalf("run on a lost session = %v, want ErrConnectionLost", err)
	}
	if err := manager.Commit(context.Background(), "owner", id); !errors.Is(err, ErrConnectionLost) {
		t.Fatalf("commit on a lost session = %v, want ErrConnectionLost", err)
	}
	if err := manager.Rollback(context.Background(), "owner", id); err != nil {
		t.Fatalf("rollback on a lost session = %v, want nil", err)
	}
	if got := mustState(t, manager, id); got != StateLost {
		t.Fatalf("state after rollback = %q, want %q", got, StateLost)
	}
	if after := server.statements(); len(after) != len(before) {
		t.Fatalf("statements reached the connection of a lost session: %v", after[len(before):])
	}
	if err := manager.Close("owner", id); err != nil {
		t.Fatalf("closing a lost session must succeed, got %v", err)
	}
}

func TestLostConnectionInsideTransactionReportsLostTransaction(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: func(err error) bool {
		return errors.Is(err, errDriverDropped)
	}})
	if err := run(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	if got := mustState(t, manager, id); got != "active" {
		t.Fatalf("state = %q, want active", got)
	}
	server.kill(errDriverDropped)
	if err := run(manager, id, "INSERT INTO t VALUES (2)"); !errors.Is(err, errDriverDropped) {
		t.Fatalf("failing run error = %v", err)
	}
	if got := mustState(t, manager, id); got != StateLostTransaction {
		t.Fatalf("state = %q, want %q", got, StateLostTransaction)
	}

	server.kill(nil)
	before := server.statements()
	if err := run(manager, id, "SELECT 1"); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("run = %v, want ErrConnectionLostInTransaction", err)
	}
	if err := manager.Commit(context.Background(), "owner", id); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("commit = %v, want ErrConnectionLostInTransaction", err)
	}
	if err := manager.SetAutoCommit("owner", id, true); err == nil {
		t.Fatal("switching mode with a lost transaction pending must be refused")
	}
	if got := mustState(t, manager, id); got != StateLostTransaction {
		t.Fatalf("state after refused commit = %q, want %q", got, StateLostTransaction)
	}
	if err := manager.Rollback(context.Background(), "owner", id); err != nil {
		t.Fatalf("rollback of a lost transaction = %v, want nil", err)
	}
	if got := mustState(t, manager, id); got != StateLost {
		t.Fatalf("state after rollback = %q, want %q", got, StateLost)
	}
	if err := run(manager, id, "SELECT 1"); !errors.Is(err, ErrConnectionLost) {
		t.Fatalf("run after rollback = %v, want ErrConnectionLost", err)
	}
	if after := server.statements(); len(after) != len(before) {
		t.Fatalf("statements reached the connection of a lost session: %v", after[len(before):])
	}
}

func TestDriverBadConnIsLostWithoutAClassifier(t *testing.T) {
	// PostgreSQL (lib/pq) and SQL Server report a dropped connection as driver.ErrBadConn.
	manager, server, id := openFakeSession(t, Options{AutoCommit: true})
	server.kill(driver.ErrBadConn)
	if err := run(manager, id, "SELECT 1"); err == nil {
		t.Fatal("expected the run to fail")
	}
	if got := mustState(t, manager, id); got != StateLost {
		t.Fatalf("state = %q, want %q", got, StateLost)
	}
}

func TestLostBeginOfImplicitTransactionIsIdleLoss(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: func(err error) bool {
		return errors.Is(err, errDriverDropped)
	}})
	server.kill(errDriverDropped)
	// Manual mode opens the transaction before the user's statement; nothing ran yet.
	if err := run(manager, id, "SELECT 1"); !errors.Is(err, errDriverDropped) {
		t.Fatalf("run = %v", err)
	}
	if got := mustState(t, manager, id); got != StateLost {
		t.Fatalf("state = %q, want %q", got, StateLost)
	}
}

func TestOrdinaryStatementErrorsDoNotMarkTheSessionLost(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{AutoCommit: true, IsConnectionLost: func(err error) bool {
		return errors.Is(err, errDriverDropped)
	}})
	server.kill(errors.New("syntax error"))
	if err := run(manager, id, "SELEC 1"); err == nil {
		t.Fatal("expected an error")
	}
	if got := mustState(t, manager, id); got != "idle" {
		t.Fatalf("state = %q, want idle", got)
	}
}

func TestLostStateRequiresTheOwner(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{AutoCommit: true})
	server.kill(driver.ErrBadConn)
	_ = run(manager, id, "SELECT 1")
	if _, err := manager.State("someone-else", id); !errors.Is(err, ErrOwnerMismatch) {
		t.Fatalf("State by another owner = %v, want ErrOwnerMismatch", err)
	}
}
