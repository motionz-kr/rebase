package adapters

import (
	"context"
	"errors"
	"io"
	"net"
	"syscall"
)

// IsTerminalNetworkError reports socket-level failures that mean an established
// connection is gone: reset or broken pipe, EOF, a closed socket, or any other
// *net.OpError that is not a timeout. Cancellation and deadlines are the caller
// giving up, not the socket dying, and are never terminal (even when wrapped).
//
// Drivers differ in how a dropped connection surfaces (go-sql-driver/mysql returns
// the raw write error for a partial packet, lib/pq the raw read error), so adapters
// use this next to their driver-specific errors.
func IsTerminalNetworkError(err error) bool {
	if err == nil ||
		errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}
