// Package sqlsession keeps a pinned SQL connection across query-editor executions.
// Connection lifetime is independent of Auto/Manual transaction mode.
package sqlsession

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

var (
	ErrNotFound            = errors.New("query session not found or expired")
	ErrOwnerMismatch       = errors.New("query session belongs to a different connection profile")
	ErrDatabaseMismatch    = errors.New("query session belongs to a different database context")
	ErrPermissionMismatch  = errors.New("query session read/write mode changed; close and reopen the query session")
	ErrNoActiveTransaction = errors.New("there is no active transaction to commit")
	ErrClosed              = errors.New("query session is closed; explicitly reconnect before executing more SQL")
)

type Manager struct {
	mu          sync.Mutex
	sessions    map[string]*session
	idleTimeout time.Duration
	stop        chan struct{}
	stopOnce    sync.Once
}

// Options are supplied by the DB adapter; SQL dialect details stay here.
type Options struct {
	AutoCommit bool
	BeginSQL   string
	Dialect    string
	Initialize func(context.Context, *sql.Conn) (int64, error)
}

type session struct {
	mu                     sync.Mutex
	ownerID, database      string
	db                     *sql.DB
	conn                   *sql.Conn
	readOnly               bool
	autoCommit             bool
	sqlAutoCommitOff       bool
	active, failed, closed bool
	beginSQL, dialect      string
	serverID               int64
	rootSavepoint          string
	lastUsed               time.Time
}

// Queryer is the subset shared by *sql.Conn and *sql.Tx.
type Queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// Lease serializes all operations on its transaction until Close is called.
type Lease struct {
	Queryer      Queryer
	ServerID     int64
	complete     func(string, error)
	query        string
	completeOnce sync.Once
	Rows         *sql.Rows
	release      func()
	once         sync.Once
}

func (l *Lease) Close() error {
	var err error
	l.once.Do(func() {
		if l.Rows != nil {
			err = l.Rows.Close()
			if err == nil {
				err = l.Rows.Err()
			}
		}
		if l.query != "" {
			l.Complete(l.query, err)
		}
		l.release()
	})
	return err
}

func NewManager(idleTimeout time.Duration) *Manager {
	m := &Manager{sessions: map[string]*session{}, idleTimeout: idleTimeout, stop: make(chan struct{})}
	if idleTimeout > 0 {
		interval := idleTimeout / 4
		if interval <= 0 || interval > time.Minute {
			interval = time.Minute
		}
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case now := <-ticker.C:
					m.ExpireIdle(now)
				case <-m.stop:
					return
				}
			}
		}()
	}
	return m
}

func (m *Manager) Open(ctx context.Context, ownerID, database string, db *sql.DB, readOnly bool, options ...Options) (string, error) {
	if ownerID == "" || db == nil {
		if db != nil {
			_ = db.Close()
		}
		return "", errors.New("profile and database connection are required")
	}
	opt := Options{BeginSQL: "BEGIN"}
	if len(options) > 0 {
		opt = options[0]
		if opt.BeginSQL == "" {
			opt.BeginSQL = "BEGIN"
		}
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return "", err
	}
	closeConnection := func() { _ = conn.Close(); _ = db.Close() }
	if err := conn.PingContext(ctx); err != nil {
		closeConnection()
		return "", err
	}
	var serverID int64
	if opt.Initialize != nil {
		serverID, err = opt.Initialize(ctx, conn)
		if err != nil {
			closeConnection()
			return "", err
		}
	}
	idBytes := make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		closeConnection()
		return "", fmt.Errorf("create query session id: %w", err)
	}
	id := hex.EncodeToString(idBytes)
	s := &session{ownerID: ownerID, database: database, db: db, conn: conn,
		readOnly: readOnly, autoCommit: opt.AutoCommit, beginSQL: opt.BeginSQL,
		dialect: opt.Dialect, serverID: serverID, lastUsed: time.Now()}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()
	return id, nil
}

func (m *Manager) Query(ctx context.Context, ownerID, database, id string, readOnly bool, query string) (*Lease, error) {
	lease, err := m.Acquire(ctx, ownerID, database, id, readOnly, query)
	if err != nil {
		return nil, err
	}
	rows, err := lease.Queryer.QueryContext(ctx, query)
	if err != nil {
		lease.Complete(query, err)
		_ = lease.Close()
		return nil, err
	}
	lease.Rows = rows
	lease.query = query
	return lease, nil
}

// Complete must be called after consuming/closing rows and before releasing the
// lease. State is metadata; native SQL on the pinned connection owns boundaries.
func (l *Lease) Complete(query string, err error) {
	l.completeOnce.Do(func() {
		if l.complete != nil {
			l.complete(query, err)
		}
	})
}

func (m *Manager) Begin(ctx context.Context, ownerID, database, id string, readOnly bool) (*Lease, error) {
	return m.Acquire(ctx, ownerID, database, id, readOnly, "")
}

func (m *Manager) Acquire(ctx context.Context, ownerID, database, id string, readOnly bool, query string) (*Lease, error) {
	s, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if err := s.validate(ownerID, database, readOnly); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	command := domain.ParseTransactionCommand(query)
	if !s.autoCommit && !s.active && (command.Action == "" || command.Action == "savepoint") && !domain.IsSessionStatement(query) {
		if _, err := s.conn.ExecContext(ctx, s.beginSQL); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		s.active = true
	}
	s.lastUsed = time.Now()
	return &Lease{Queryer: s.conn, ServerID: s.serverID, complete: s.complete,
		release: func() { s.lastUsed = time.Now(); s.mu.Unlock() }}, nil
}

// State is read without issuing any SQL on the user's connection.
func (m *Manager) State(ownerID, id string) (string, error) {
	s, err := m.lookup(id)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validate(ownerID, s.database, s.readOnly); err != nil {
		return "", err
	}
	if s.failed {
		return "failed", nil
	}
	if s.active {
		return "active", nil
	}
	return "idle", nil
}

func (s *session) complete(query string, err error) {
	if errors.Is(err, domain.ErrRowLimitReached) {
		err = nil
	}
	if err != nil {
		if s.active {
			s.failed = true
		}
		if errors.Is(err, sql.ErrConnDone) || errors.Is(err, driver.ErrBadConn) {
			s.closed = true
		}
		return
	}
	command := domain.ParseTransactionCommand(query)
	switch command.Action {
	case "begin":
		s.active = true
		s.failed = false
		s.rootSavepoint = ""
	case "savepoint":
		if !s.active && s.dialect == "sqlite" {
			s.rootSavepoint = command.Name
			s.active = true
		}
		s.failed = false
	case "rollback-to":
		s.failed = false
	case "release":
		if s.rootSavepoint != "" && s.rootSavepoint == command.Name {
			s.active = false
			s.failed = false
			s.rootSavepoint = ""
		}
	case "commit", "rollback":
		s.active = command.Chain
		s.failed = false
		s.rootSavepoint = ""
	default:
		if s.sqlAutoCommitOff && !domain.IsSessionStatement(query) {
			s.active = true
		}
	}
	// MySQL's native implicit boundaries must not leave the toolbar claiming that
	// committed work can still be rolled back. The SQL itself is never rewritten.
	if s.dialect == "mysql" {
		if value, ok := mysqlAutoCommit(query); ok {
			s.sqlAutoCommitOff = !value
			if value {
				s.active = false
				s.failed = false
			}
		} else if mysqlImplicitCommit(query) {
			s.active = false
			s.failed = false
		}
	}
}

func (m *Manager) Commit(ctx context.Context, ownerID, id string) error {
	return m.finish(ctx, ownerID, id, "COMMIT")
}

func (m *Manager) Rollback(ctx context.Context, ownerID, id string) error {
	return m.finish(ctx, ownerID, id, "ROLLBACK")
}

func (m *Manager) finish(ctx context.Context, ownerID, id, statement string) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validate(ownerID, s.database, s.readOnly); err != nil {
		return err
	}
	if !s.active {
		if statement == "COMMIT" {
			return ErrNoActiveTransaction
		}
		return nil
	}
	_, err = s.conn.ExecContext(ctx, statement)
	s.complete(statement, err)
	s.lastUsed = time.Now()
	return err
}

// Mode changes preserve session settings. The caller must resolve pending work.
func (m *Manager) SetAutoCommit(ownerID, id string, autoCommit bool) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validate(ownerID, s.database, s.readOnly); err != nil {
		return err
	}
	if s.active || s.failed {
		return errors.New("commit or rollback the pending transaction before changing mode")
	}
	s.autoCommit = autoCommit
	return nil
}

// Close always rolls back an outstanding transaction before releasing the
// dedicated connection. It never implicitly commits user changes.
func (m *Manager) Close(ownerID, id string) error {
	s, err := m.lookup(id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	s.mu.Lock()
	if s.ownerID != ownerID {
		s.mu.Unlock()
		return ErrOwnerMismatch
	}
	closeErr := s.closeLocked()
	s.mu.Unlock()
	m.remove(id, s)
	return closeErr
}

func (m *Manager) ExpireIdle(now time.Time) {
	m.mu.Lock()
	entries := make(map[string]*session, len(m.sessions))
	for id, s := range m.sessions {
		entries[id] = s
	}
	m.mu.Unlock()

	for id, s := range entries {
		s.mu.Lock()
		if m.idleTimeout <= 0 || now.Sub(s.lastUsed) < m.idleTimeout {
			s.mu.Unlock()
			continue
		}
		_ = s.closeLocked()
		s.mu.Unlock()
		m.remove(id, s)
	}
}

func (m *Manager) Shutdown() {
	m.stopOnce.Do(func() { close(m.stop) })
	m.mu.Lock()
	entries := make(map[string]*session, len(m.sessions))
	for id, s := range m.sessions {
		entries[id] = s
	}
	m.mu.Unlock()
	for id, s := range entries {
		s.mu.Lock()
		_ = s.closeLocked()
		s.mu.Unlock()
		m.remove(id, s)
	}
}

func (m *Manager) lookup(id string) (*session, error) {
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s == nil {
		return nil, ErrNotFound
	}
	return s, nil
}

func (m *Manager) remove(id string, expected *session) {
	m.mu.Lock()
	if m.sessions[id] == expected {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
}

func (s *session) validate(ownerID, database string, readOnly bool) error {
	if s.closed {
		return ErrClosed
	}
	if s.ownerID != ownerID {
		return ErrOwnerMismatch
	}
	if s.database != database {
		return ErrDatabaseMismatch
	}
	if s.readOnly != readOnly {
		return ErrPermissionMismatch
	}
	return nil
}

func (s *session) closeLocked() error {
	// Always issue rollback: procedures or SQL not understood by state tracking
	// can also open transactions. Never return a live transaction to a pool.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, rollbackErr := s.conn.ExecContext(ctx, "ROLLBACK")
	// PostgreSQL/SQLite may report no active transaction; closing the dedicated
	// DB still rolls back at the server. No user query is retried.
	_ = rollbackErr
	s.closed = true
	connErr := s.conn.Close()
	dbErr := s.db.Close()
	if connErr != nil && !errors.Is(connErr, sql.ErrConnDone) {
		return connErr
	}
	return dbErr
}
