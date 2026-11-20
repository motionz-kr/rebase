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
	// applyThenDrop: this statement is applied on the "server" but its reply is
	// lost, after which the connection is down (a COMMIT whose OK never arrives).
	applyThenDrop string
	// applyThenCancel: this statement is applied, then the caller's context is
	// cancelled before the reply arrives. Like go-sql-driver/mysql, the connection
	// is closed by the cancellation (later statements get driver.ErrBadConn) unless
	// cancelKeepsConn is set.
	applyThenCancel string
	cancelKeepsConn bool
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
	if f.applyThenCancel != "" && query == f.applyThenCancel {
		if !f.cancelKeepsConn {
			f.down = driver.ErrBadConn
		}
		return context.Canceled
	}
	if f.applyThenDrop != "" && query == f.applyThenDrop {
		f.down = errDriverDropped
		return errDriverDropped
	}
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
	if err := run(manager, id, "SELECT 1"); !errors.Is(err, ErrConnectionLost) {
		t.Fatalf("run = %v, want ErrConnectionLost", err)
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

func isDropped(err error) bool { return errors.Is(err, errDriverDropped) }

// completeStatement is what adapters do: run on the leased connection, then Complete.
func completeStatement(manager *Manager, id, query string) error {
	lease, err := manager.Acquire(context.Background(), "owner", "db", id, false, query)
	if err != nil {
		return err
	}
	defer lease.Close()
	_, err = lease.Queryer.ExecContext(context.Background(), query)
	return lease.Complete(query, err)
}

func TestCompleteReturnsTheCuratedErrorWhenItDetectsLoss(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: isDropped})
	if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	server.kill(errDriverDropped)
	if err := completeStatement(manager, id, "INSERT INTO t VALUES (2)"); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("loss inside a transaction = %v, want ErrConnectionLostInTransaction", err)
	}
	// An ordinary failure is returned untouched.
	other, server2, id2 := openFakeSession(t, Options{AutoCommit: true, IsConnectionLost: isDropped})
	boom := errors.New("duplicate key")
	server2.kill(boom)
	if err := completeStatement(other, id2, "INSERT INTO t VALUES (1)"); !errors.Is(err, boom) {
		t.Fatalf("ordinary error = %v", err)
	}
}

func TestCommitLostWhileExecutingHasAnUnknownOutcome(t *testing.T) {
	for name, commit := range map[string]func(*Manager, string) error{
		"SQL COMMIT":           func(m *Manager, id string) error { return completeStatement(m, id, "COMMIT") },
		"SQL END":              func(m *Manager, id string) error { return completeStatement(m, id, "END") },
		"SQL COMMIT AND CHAIN": func(m *Manager, id string) error { return completeStatement(m, id, "COMMIT AND CHAIN") },
		"toolbar commit":       func(m *Manager, id string) error { return m.Commit(context.Background(), "owner", id) },
	} {
		t.Run(name, func(t *testing.T) {
			manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: isDropped})
			if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			// The server applies the COMMIT, but the reply is lost.
			server.mu.Lock()
			server.applyThenDrop = map[string]string{"SQL END": "END", "SQL COMMIT AND CHAIN": "COMMIT AND CHAIN"}[name]
			if server.applyThenDrop == "" {
				server.applyThenDrop = "COMMIT"
			}
			server.mu.Unlock()

			if err := commit(manager, id); !errors.Is(err, ErrCommitOutcomeUnknown) {
				t.Fatalf("commit error = %v, want ErrCommitOutcomeUnknown", err)
			}
			if got := mustState(t, manager, id); got != StateLost {
				t.Fatalf("state = %q, want %q (the commit may be durable, so there is nothing to roll back)", got, StateLost)
			}
			// Every later action repeats the unknown outcome and sends no SQL.
			server.kill(nil)
			before := server.statements()
			if err := run(manager, id, "SELECT 1"); !errors.Is(err, ErrCommitOutcomeUnknown) {
				t.Fatalf("run = %v, want ErrCommitOutcomeUnknown", err)
			}
			if err := manager.Commit(context.Background(), "owner", id); !errors.Is(err, ErrCommitOutcomeUnknown) {
				t.Fatalf("second commit = %v, want ErrCommitOutcomeUnknown", err)
			}
			if err := manager.Rollback(context.Background(), "owner", id); err != nil {
				t.Fatalf("rollback = %v", err)
			}
			if got := mustState(t, manager, id); got != StateLost {
				t.Fatalf("state after rollback = %q", got)
			}
			if after := server.statements(); len(after) != len(before) {
				t.Fatalf("SQL reached a lost session: %v", after[len(before):])
			}
		})
	}
}

func TestLossBeforeCommitStillNeedsARollback(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: isDropped})
	if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	server.kill(errDriverDropped)
	if err := completeStatement(manager, id, "INSERT INTO t VALUES (2)"); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("insert = %v", err)
	}
	if got := mustState(t, manager, id); got != StateLostTransaction {
		t.Fatalf("state = %q, want %q", got, StateLostTransaction)
	}
	if err := manager.Commit(context.Background(), "owner", id); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("commit after earlier loss = %v, want ErrConnectionLostInTransaction", err)
	}
}

func TestCleanupOfALostSessionIssuesNoSQL(t *testing.T) {
	for name, cleanup := range map[string]func(*Manager, string){
		"Close":      func(m *Manager, id string) { _ = m.Close("owner", id) },
		"ExpireIdle": func(m *Manager, id string) { m.ExpireIdle(time.Now().Add(2 * time.Hour)) },
		"Shutdown":   func(m *Manager, id string) { m.Shutdown() },
	} {
		t.Run(name, func(t *testing.T) {
			manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN", IsConnectionLost: isDropped})
			if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			server.kill(errDriverDropped)
			_ = completeStatement(manager, id, "INSERT INTO t VALUES (2)")
			// The server comes back for an unrelated reason; a ROLLBACK sent now
			// would reach it and could end someone else's work on a reused handle.
			server.kill(nil)
			before := server.statements()
			cleanup(manager, id)
			if after := server.statements(); len(after) != len(before) {
				t.Fatalf("%s sent SQL on a lost session: %v", name, after[len(before):])
			}
			if _, err := manager.State("owner", id); !errors.Is(err, ErrNotFound) {
				t.Fatalf("session must be removed after %s, State = %v", name, err)
			}
		})
	}
}

func TestCleanupOfAHealthySessionStillRollsBack(t *testing.T) {
	manager, server, id := openFakeSession(t, Options{BeginSQL: "BEGIN"})
	if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	if err := manager.Close("owner", id); err != nil {
		t.Fatal(err)
	}
	stmts := server.statements()
	if len(stmts) == 0 || stmts[len(stmts)-1] != "ROLLBACK" {
		t.Fatalf("Close must roll back an open transaction, statements: %v", stmts)
	}
}

func (f *fakeServer) set(fn func(*fakeServer)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func mysqlOptions() Options {
	return Options{BeginSQL: "START TRANSACTION", Dialect: "mysql", IsConnectionLost: isDropped}
}

func TestCommitCancelledBeforeItsReplyHasAnUnknownOutcome(t *testing.T) {
	for name, commit := range map[string]func(*Manager, string) error{
		"SQL COMMIT":     func(m *Manager, id string) error { return completeStatement(m, id, "COMMIT") },
		"toolbar commit": func(m *Manager, id string) error { return m.Commit(context.Background(), "owner", id) },
	} {
		for _, discover := range []string{"next statement", "toolbar rollback"} {
			t.Run(name+"/"+discover, func(t *testing.T) {
				manager, server, id := openFakeSession(t, mysqlOptions())
				if err := completeStatement(manager, id, "UPDATE t SET a = 1"); err != nil {
					t.Fatal(err)
				}
				server.set(func(f *fakeServer) { f.applyThenCancel = "COMMIT" })

				if err := commit(manager, id); !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled commit = %v, want context.Canceled (not a loss yet)", err)
				}
				if got := mustState(t, manager, id); got != StateFailed {
					t.Fatalf("state right after the cancel = %q, want %q", got, StateFailed)
				}
				var err error
				if discover == "next statement" {
					err = completeStatement(manager, id, "SELECT 1")
				} else {
					err = manager.Rollback(context.Background(), "owner", id)
				}
				if !errors.Is(err, ErrCommitOutcomeUnknown) {
					t.Fatalf("discovering the closed connection = %v, want ErrCommitOutcomeUnknown", err)
				}
				if got := mustState(t, manager, id); got != StateLost {
					t.Fatalf("state = %q, want %q: the COMMIT is in the server log %v, so rollback must not be offered", got, StateLost, server.statements())
				}
				if err := manager.Rollback(context.Background(), "owner", id); err != nil {
					t.Fatalf("rollback after loss = %v", err)
				}
				if got := mustState(t, manager, id); got != StateLost {
					t.Fatalf("state after rollback = %q", got)
				}
			})
		}
	}
}

func TestImplicitCommitBoundariesWithLostReplyHaveAnUnknownOutcome(t *testing.T) {
	for _, statement := range []string{
		"SET autocommit=1",
		"SET SESSION AUTOCOMMIT = ON",
		"CREATE TABLE x (a int)",
		"ALTER TABLE t ADD COLUMN b int",
		"TRUNCATE TABLE t",
		"START TRANSACTION",
		"LOCK TABLES t WRITE",
	} {
		for _, how := range []string{"dropped", "cancelled"} {
			t.Run(statement+"/"+how, func(t *testing.T) {
				manager, server, id := openFakeSession(t, mysqlOptions())
				if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
					t.Fatal(err)
				}
				server.set(func(f *fakeServer) {
					if how == "dropped" {
						f.applyThenDrop = statement
					} else {
						f.applyThenCancel = statement
					}
				})
				err := completeStatement(manager, id, statement)
				if how == "cancelled" {
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("cancelled = %v", err)
					}
					err = completeStatement(manager, id, "SELECT 1")
				}
				if !errors.Is(err, ErrCommitOutcomeUnknown) {
					t.Fatalf("%s = %v, want ErrCommitOutcomeUnknown", statement, err)
				}
				if got := mustState(t, manager, id); got != StateLost {
					t.Fatalf("state = %q, want %q", got, StateLost)
				}
			})
		}
	}
}

func TestAutocommitOffAndPostgresDDLAreNotCommitBoundaries(t *testing.T) {
	// SET autocommit=0 commits nothing; PostgreSQL DDL is transactional.
	for name, tc := range map[string]struct {
		opts      Options
		statement string
	}{
		"mysql autocommit off": {mysqlOptions(), "SET autocommit=0"},
		"postgres ddl":         {Options{BeginSQL: "BEGIN", Dialect: "postgres", IsConnectionLost: isDropped}, "CREATE TABLE x (a int)"},
	} {
		t.Run(name, func(t *testing.T) {
			manager, server, id := openFakeSession(t, tc.opts)
			if err := completeStatement(manager, id, "INSERT INTO t VALUES (1)"); err != nil {
				t.Fatal(err)
			}
			server.set(func(f *fakeServer) { f.applyThenDrop = tc.statement })
			if err := completeStatement(manager, id, tc.statement); !errors.Is(err, ErrConnectionLostInTransaction) {
				t.Fatalf("%s = %v, want ErrConnectionLostInTransaction", tc.statement, err)
			}
			if got := mustState(t, manager, id); got != StateLostTransaction {
				t.Fatalf("state = %q", got)
			}
		})
	}
}

func TestOrdinaryQueryCancellationStaysDistinctFromCommitUncertainty(t *testing.T) {
	manager, server, id := openFakeSession(t, mysqlOptions())
	if err := completeStatement(manager, id, "UPDATE t SET a = 1"); err != nil {
		t.Fatal(err)
	}
	server.set(func(f *fakeServer) { f.applyThenCancel = "SELECT slow" })
	if err := completeStatement(manager, id, "SELECT slow"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled select = %v", err)
	}
	if got := mustState(t, manager, id); got != StateFailed {
		t.Fatalf("state after a cancelled SELECT = %q, want %q", got, StateFailed)
	}
	// The closed connection is found later: the transaction really was aborted.
	if err := completeStatement(manager, id, "SELECT 1"); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("later statement = %v, want ErrConnectionLostInTransaction", err)
	}
	if got := mustState(t, manager, id); got != StateLostTransaction {
		t.Fatalf("state = %q, want %q", got, StateLostTransaction)
	}
}

func TestCommitUncertaintyEndsWithTheNextSuccessfulStatement(t *testing.T) {
	// A cancelled COMMIT on a connection that survives: once a statement succeeds
	// again, a later, unrelated loss is an ordinary lost transaction.
	manager, server, id := openFakeSession(t, mysqlOptions())
	if err := completeStatement(manager, id, "UPDATE t SET a = 1"); err != nil {
		t.Fatal(err)
	}
	server.set(func(f *fakeServer) { f.applyThenCancel = "COMMIT"; f.cancelKeepsConn = true })
	if err := completeStatement(manager, id, "COMMIT"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled commit = %v", err)
	}
	server.set(func(f *fakeServer) { f.applyThenCancel = "" })
	if err := completeStatement(manager, id, "UPDATE t SET a = 2"); err != nil {
		t.Fatal(err)
	}
	server.kill(errDriverDropped)
	if err := completeStatement(manager, id, "UPDATE t SET a = 3"); !errors.Is(err, ErrConnectionLostInTransaction) {
		t.Fatalf("later loss = %v, want ErrConnectionLostInTransaction", err)
	}
}
