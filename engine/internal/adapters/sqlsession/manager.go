// Package sqlsession keeps a dedicated SQL connection and manual transaction
// alive across separate query-editor executions.
package sqlsession

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrNotFound            = errors.New("query session not found or expired")
	ErrOwnerMismatch       = errors.New("query session belongs to a different connection profile")
	ErrDatabaseMismatch    = errors.New("query session belongs to a different database context")
	ErrPermissionMismatch  = errors.New("query session read/write mode changed; close and reopen the manual session")
	ErrNoActiveTransaction = errors.New("there is no active transaction to commit")
)

type Manager struct {
	mu          sync.Mutex
	sessions    map[string]*session
	idleTimeout time.Duration
	stop        chan struct{}
	stopOnce    sync.Once
}

type session struct {
	mu                  sync.Mutex
	ownerID             string
	database            string
	db                  *sql.DB
	conn                *sql.Conn
	tx                  *sql.Tx
	txCancel            context.CancelFunc
	readOnly            bool
	transactionReadOnly bool
	lastUsed            time.Time
}

// Queryer is the subset shared by *sql.Conn and *sql.Tx.
type Queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// Lease serializes all operations on its transaction until Close is called.
type Lease struct {
	Queryer Queryer
	Rows    *sql.Rows
	release func()
	once    sync.Once
}

func (l *Lease) Close() error {
	var err error
	l.once.Do(func() {
		if l.Rows != nil {
			err = l.Rows.Close()
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

func (m *Manager) Open(ctx context.Context, ownerID, database string, db *sql.DB, readOnly, transactionReadOnly bool) (string, error) {
	if ownerID == "" || db == nil {
		if db != nil {
			_ = db.Close()
		}
		return "", errors.New("profile and database connection are required")
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return "", err
	}
	if err := conn.PingContext(ctx); err != nil {
		_ = conn.Close()
		_ = db.Close()
		return "", err
	}

	idBytes := make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		_ = conn.Close()
		_ = db.Close()
		return "", fmt.Errorf("create query session id: %w", err)
	}
	id := hex.EncodeToString(idBytes)
	s := &session{
		ownerID: ownerID, database: database, db: db, conn: conn,
		readOnly: readOnly, transactionReadOnly: transactionReadOnly, lastUsed: time.Now(),
	}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()
	return id, nil
}

func (m *Manager) Query(ctx context.Context, ownerID, database, id string, readOnly bool, query string) (*Lease, error) {
	lease, err := m.Begin(ctx, ownerID, database, id, readOnly)
	if err != nil {
		return nil, err
	}
	rows, err := lease.Queryer.QueryContext(ctx, query)
	if err != nil {
		_ = lease.Close()
		return nil, err
	}
	lease.Rows = rows
	return lease, nil
}

func (m *Manager) Begin(ctx context.Context, ownerID, database, id string, readOnly bool) (*Lease, error) {
	s, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if err := s.validate(ownerID, database, readOnly); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if s.tx == nil {
		// The SQL transaction belongs to the query tab, not to the HTTP request
		// that happened to issue its first statement. database/sql automatically
		// rolls a transaction back when its BeginTx context is canceled, so use a
		// session-owned context and keep request cancellation scoped to QueryContext.
		txContext, cancelTransaction := context.WithCancel(context.Background())
		tx, err := s.conn.BeginTx(txContext, &sql.TxOptions{ReadOnly: s.transactionReadOnly && s.readOnly})
		if err != nil {
			cancelTransaction()
			s.lastUsed = time.Now()
			s.mu.Unlock()
			return nil, err
		}
		s.tx = tx
		s.txCancel = cancelTransaction
	}
	s.lastUsed = time.Now()
	return &Lease{
		Queryer: s.tx,
		release: func() {
			s.lastUsed = time.Now()
			s.mu.Unlock()
		},
	}, nil
}

func (m *Manager) Commit(ctx context.Context, ownerID, id string) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validate(ownerID, s.database, s.readOnly); err != nil {
		return err
	}
	if s.tx == nil {
		return ErrNoActiveTransaction
	}
	tx := s.tx
	s.tx = nil
	cancel := s.txCancel
	s.txCancel = nil
	s.lastUsed = time.Now()
	err = tx.Commit()
	if cancel != nil {
		cancel()
	}
	return err
}

func (m *Manager) Rollback(ctx context.Context, ownerID, id string) error {
	s, err := m.lookup(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.validate(ownerID, s.database, s.readOnly); err != nil {
		return err
	}
	if s.tx == nil {
		s.lastUsed = time.Now()
		return nil
	}
	tx := s.tx
	s.tx = nil
	cancel := s.txCancel
	s.txCancel = nil
	s.lastUsed = time.Now()
	err = tx.Rollback()
	if cancel != nil {
		cancel()
	}
	return err
}

// Close always rolls back an outstanding transaction before releasing the
// dedicated connection. It never implicitly commits user changes.
func (m *Manager) Close(ownerID, id string) error {
	s, err := m.lookup(id)
	if err != nil {
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
	var firstErr error
	if s.tx != nil {
		if err := s.tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			firstErr = err
		}
		s.tx = nil
	}
	if s.txCancel != nil {
		s.txCancel()
		s.txCancel = nil
	}
	if err := s.conn.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	if err := s.db.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	return firstErr
}
