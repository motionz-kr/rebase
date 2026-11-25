package adapters

import (
	"context"
	"errors"
	"net"
	"syscall"
	"time"
)

type SSMDialer struct{}

func (d SSMDialer) Dial(network, addr string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, addr)
}

func (d SSMDialer) DialTimeout(network, addr string, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return d.DialContext(ctx, network, addr)
}

func (d SSMDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := net.Dialer{}
	for attempt := 0; ; attempt++ {
		conn, err := dialer.DialContext(ctx, network, addr)
		// Retry only before a local socket was opened. Once accepted, the DB
		// driver owns the socket and can finish authentication on it.
		if !errors.Is(err, syscall.ECONNREFUSED) || attempt == 4 {
			return conn, err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
