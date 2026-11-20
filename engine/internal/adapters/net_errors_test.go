package adapters

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
)

func TestIsTerminalNetworkError(t *testing.T) {
	reset := &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
	terminal := map[string]error{
		"connection reset": reset,
		"wrapped reset":    errors.Join(errors.New("scan"), reset),
		"broken pipe":      &net.OpError{Op: "write", Net: "tcp", Err: os.NewSyscallError("write", syscall.EPIPE)},
		"bare EPIPE":       fmt.Errorf("write: %w", syscall.EPIPE),
		"bare ECONNRESET":  syscall.ECONNRESET,
		"EOF":              io.EOF,
		"unexpected EOF":   fmt.Errorf("read: %w", io.ErrUnexpectedEOF),
		"closed socket":    net.ErrClosed,
		"other op error":   &net.OpError{Op: "write", Net: "tcp", Err: errors.New("no route to host")},
	}
	for name, err := range terminal {
		if !IsTerminalNetworkError(err) {
			t.Errorf("%s must be terminal", name)
		}
	}
	notTerminal := map[string]error{
		"nil":                        nil,
		"plain error":                errors.New("syntax error"),
		"cancel":                     context.Canceled,
		"deadline":                   context.DeadlineExceeded,
		"read timeout":               &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded},
		"op error wrapping cancel":   &net.OpError{Op: "read", Net: "tcp", Err: context.Canceled},
		"op error wrapping deadline": &net.OpError{Op: "read", Net: "tcp", Err: context.DeadlineExceeded},
		"cancel wrapping reset":      fmt.Errorf("query: %w", errors.Join(context.Canceled, reset)),
		"EOF after cancel":           errors.Join(context.Canceled, io.EOF),
	}
	for name, err := range notTerminal {
		if IsTerminalNetworkError(err) {
			t.Errorf("%s must not be terminal", name)
		}
	}
}
