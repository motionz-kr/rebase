package postgres

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"
	"testing"

	pqDriver "github.com/lib/pq"
)

// lib/pq maps EOF, failed writes and FATAL server errors to driver.ErrBadConn
// (handled by sqlsession already), but passes a read-side connection reset
// through as a *net.OpError and only marks the connection bad afterwards.
func TestIsConnectionLostRecognisesResetSockets(t *testing.T) {
	reset := &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
	if !isConnectionLost(reset) {
		t.Error("connection reset must be lost")
	}
	if !isConnectionLost(errors.Join(errors.New("scan"), reset)) {
		t.Error("wrapped connection reset must be lost")
	}
	for name, err := range map[string]error{
		"nil":          nil,
		"sql error":    &pqDriver.Error{Code: "42601", Message: "syntax error"},
		"context":      context.Canceled,
		"read timeout": &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded},
	} {
		if isConnectionLost(err) {
			t.Errorf("%s must not be lost", name)
		}
	}
}
