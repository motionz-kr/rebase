package mysql

import (
	"bufio"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlsession"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

// fakeMySQLServer speaks just enough of the MySQL wire protocol to let the real
// go-sql-driver/mysql connect and open a query session, then lets a test drop
// the TCP connection the way a closed SSM/SSH tunnel or proxy restart does.
type fakeMySQLServer struct {
	listener net.Listener
	mu       sync.Mutex
	conns    []net.Conn
	// onQuery runs for every COM_QUERY other than the session bootstrap
	// (SELECT CONNECTION_ID()); returning true closes the socket without replying.
	onQuery func(query string) (dropWithoutReply bool)
}

func newFakeMySQLServer(t *testing.T) *fakeMySQLServer {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeMySQLServer{listener: l}
	t.Cleanup(func() {
		_ = l.Close()
		s.dropAll()
	})
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns = append(s.conns, conn)
			s.mu.Unlock()
			go s.serve(conn)
		}
	}()
	return s
}

func (s *fakeMySQLServer) port() int { return s.listener.Addr().(*net.TCPAddr).Port }

func (s *fakeMySQLServer) dropAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		_ = c.Close()
	}
}

func writePacket(w io.Writer, seq byte, payload []byte) error {
	header := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), seq}
	_, err := w.Write(append(header, payload...))
	return err
}

func readPacket(r io.Reader) (seq byte, payload []byte, err error) {
	header := make([]byte, 4)
	if _, err = io.ReadFull(r, header); err != nil {
		return 0, nil, err
	}
	payload = make([]byte, int(header[0])|int(header[1])<<8|int(header[2])<<16)
	_, err = io.ReadFull(r, payload)
	return header[3], payload, err
}

var okPacket = []byte{0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00}
var eofPacket = []byte{0xfe, 0x00, 0x00, 0x02, 0x00}

func (s *fakeMySQLServer) serve(conn net.Conn) {
	defer conn.Close()
	greeting := []byte{0x0a}
	greeting = append(greeting, []byte("8.0.0-fake\x00")...)
	greeting = append(greeting, 1, 0, 0, 0)                             // connection id
	greeting = append(greeting, []byte("abcdefgh")...)                  // auth data 1
	greeting = append(greeting, 0x00)                                   // filler
	greeting = append(greeting, 0x09, 0x82)                             // caps low: LONG_PASSWORD|CONNECT_WITH_DB|PROTOCOL_41|SECURE_CONNECTION
	greeting = append(greeting, 0x21, 0x02, 0x00)                       // charset, status
	greeting = append(greeting, 0x08, 0x00)                             // caps high: PLUGIN_AUTH
	greeting = append(greeting, 21)                                     // auth data length
	greeting = append(greeting, make([]byte, 10)...)                    // reserved
	greeting = append(greeting, []byte("ijklmnopqrst\x00")...)          // auth data 2
	greeting = append(greeting, []byte("mysql_native_password\x00")...) // plugin
	if writePacket(conn, 0, greeting) != nil {
		return
	}
	reader := bufio.NewReader(conn)
	if _, _, err := readPacket(reader); err != nil { // handshake response
		return
	}
	if writePacket(conn, 2, okPacket) != nil {
		return
	}
	for {
		_, payload, err := readPacket(reader)
		if err != nil || len(payload) == 0 {
			return
		}
		switch payload[0] {
		case 0x0e: // COM_PING
			_ = writePacket(conn, 1, okPacket)
		case 0x03: // COM_QUERY
			query := string(payload[1:])
			if strings.Contains(query, "CONNECTION_ID") {
				s.connectionIDResult(conn)
				continue
			}
			if s.onQuery != nil && s.onQuery(query) {
				return // closes the socket mid-statement, no reply
			}
			_ = writePacket(conn, 1, okPacket)
		default:
			return
		}
	}
}

func (s *fakeMySQLServer) connectionIDResult(conn net.Conn) {
	column := []byte{}
	for _, field := range []string{"def", "", "", "", "CONNECTION_ID()", ""} {
		column = append(column, byte(len(field)))
		column = append(column, field...)
	}
	column = append(column, 0x0c, 0x3f, 0x00)
	length := make([]byte, 4)
	binary.LittleEndian.PutUint32(length, 20)
	column = append(column, length...)
	column = append(column, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00)
	_ = writePacket(conn, 1, []byte{0x01})
	_ = writePacket(conn, 2, column)
	_ = writePacket(conn, 3, eofPacket)
	_ = writePacket(conn, 4, []byte{0x01, '7'})
	_ = writePacket(conn, 5, eofPacket)
}

func (s *fakeMySQLServer) profile() domain.ConnectionProfile {
	return domain.ConnectionProfile{ID: "p", Driver: "mysql", Host: "127.0.0.1", Port: s.port(),
		Database: "app", Username: "root", TLSMode: "none"}
}

func TestIsConnectionLostRecognisesDriverErrors(t *testing.T) {
	for name, err := range map[string]error{
		"invalid connection": mysqlDriver.ErrInvalidConn,
		"wrapped":            errors.Join(errors.New("scan"), mysqlDriver.ErrInvalidConn),
	} {
		if !isConnectionLost(err) {
			t.Errorf("%s: isConnectionLost = false", name)
		}
	}
	for name, err := range map[string]error{
		"nil":             nil,
		"syntax error":    &mysqlDriver.MySQLError{Number: 1064, Message: "syntax"},
		"query cancelled": &mysqlDriver.MySQLError{Number: 1317, Message: "Query execution was interrupted"},
		"deadlock":        &mysqlDriver.MySQLError{Number: 1213, Message: "deadlock"},
		"context":         context.Canceled,
		"row limit":       domain.ErrRowLimitReached,
	} {
		if isConnectionLost(err) {
			t.Errorf("%s: isConnectionLost = true", name)
		}
	}
}

// Documents what the real driver returns for a pinned *sql.Conn whose server
// side vanished, and proves isConnectionLost covers each variant.
func TestRealDriverReportsDroppedPinnedConnectionAsLost(t *testing.T) {
	for name, tc := range map[string]struct {
		onQuery  func(string) bool
		dropIdle bool
	}{
		"dropped while idle":    {dropIdle: true},
		"dropped mid-statement": {onQuery: func(string) bool { return true }},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeMySQLServer(t)
			server.onQuery = tc.onQuery
			dsn := "root@tcp(127.0.0.1:" + strconv.Itoa(server.port()) + ")/app?timeout=2s"
			db, err := sql.Open("mysql", dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.PingContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			if tc.dropIdle {
				server.dropAll()
				time.Sleep(50 * time.Millisecond)
			}
			_, first := conn.ExecContext(context.Background(), "UPDATE t SET a = 1")
			if first == nil {
				t.Fatal("statement on a dropped connection must fail")
			}
			_, second := conn.ExecContext(context.Background(), "UPDATE t SET a = 2")
			t.Logf("first error: %T %v; second error: %T %v", first, first, second, second)
			sessionLost := func(err error) bool {
				return errors.Is(err, sql.ErrConnDone) || errors.Is(err, driver.ErrBadConn) || isConnectionLost(err)
			}
			if !sessionLost(first) || !sessionLost(second) {
				t.Fatalf("errors %v / %v are not classified as a lost connection", first, second)
			}
		})
	}
}

func TestOpenQuerySessionWiresTheClassifierForDroppedConnections(t *testing.T) {
	for name, tc := range map[string]struct {
		autoCommit bool
		before     string // statement answered normally before the connection drops
		wantState  string
		wantErr    error
	}{
		"auto session":                {autoCommit: true, wantState: sqlsession.StateLost, wantErr: sqlsession.ErrConnectionLost},
		"manual session, idle":        {wantState: sqlsession.StateLost, wantErr: sqlsession.ErrConnectionLost},
		"manual session, transaction": {before: "UPDATE t SET a = 1", wantState: sqlsession.StateLostTransaction, wantErr: sqlsession.ErrConnectionLostInTransaction},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeMySQLServer(t)
			connector := NewMySQLConnector()
			t.Cleanup(connector.querySessions.Shutdown)
			ctx := context.Background()
			id, err := connector.OpenQuerySession(ctx, server.profile(), "", "owner", "app", false, tc.autoCommit)
			if err != nil {
				t.Fatal(err)
			}
			run := func(query string) error {
				_, err := connector.ExecuteQuerySessionStream(ctx, server.profile(), "", "owner", "app", id,
					query, false, nil, func([]string) error { return nil }, func([]any) error { return nil })
				return err
			}
			if tc.before != "" {
				if err := run(tc.before); err != nil {
					t.Fatal(err)
				}
			}
			server.dropAll()
			time.Sleep(50 * time.Millisecond)

			// The statement that discovers the loss already reports the curated error.
			if err := run("SELECT 75"); !errors.Is(err, tc.wantErr) {
				t.Fatalf("first run = %v, want %v", err, tc.wantErr)
			}
			state, err := connector.QuerySessionState("owner", id)
			if err != nil || state != tc.wantState {
				t.Fatalf("state = %q, %v; want %q", state, err, tc.wantState)
			}
			if err := run("SELECT 75"); !errors.Is(err, tc.wantErr) {
				t.Fatalf("second run = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

// The server receives COMMIT but the connection drops before the reply: the
// outcome is unknown, so the session is plain "lost" with the commit message.
func TestCommitLostOnTheWireHasAnUnknownOutcome(t *testing.T) {
	for name, commit := range map[string]func(context.Context, *MySQLConnector, domain.ConnectionProfile, string) error{
		"toolbar commit": func(ctx context.Context, c *MySQLConnector, _ domain.ConnectionProfile, id string) error {
			return c.CommitQuerySession(ctx, "owner", id)
		},
		"SQL COMMIT": func(ctx context.Context, c *MySQLConnector, p domain.ConnectionProfile, id string) error {
			_, err := c.ExecuteQuerySessionStream(ctx, p, "", "owner", "app", id, "COMMIT", false, nil,
				func([]string) error { return nil }, func([]any) error { return nil })
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := newFakeMySQLServer(t)
			server.onQuery = func(query string) bool { return query == "COMMIT" }
			connector := NewMySQLConnector()
			t.Cleanup(connector.querySessions.Shutdown)
			ctx := context.Background()
			profile := server.profile()
			id, err := connector.OpenQuerySession(ctx, profile, "", "owner", "app", false, false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := connector.ExecuteQuerySessionStream(ctx, profile, "", "owner", "app", id, "UPDATE t SET a = 1", false, nil,
				func([]string) error { return nil }, func([]any) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if err := commit(ctx, connector, profile, id); !errors.Is(err, sqlsession.ErrCommitOutcomeUnknown) {
				t.Fatalf("commit = %v, want ErrCommitOutcomeUnknown", err)
			}
			if state, err := connector.QuerySessionState("owner", id); err != nil || state != sqlsession.StateLost {
				t.Fatalf("state = %q, %v; want lost", state, err)
			}
		})
	}
}
