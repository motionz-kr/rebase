package adapters

import "errors"

var (
	ErrAuthFailed         = errors.New("authentication failed: invalid username or password")
	ErrNetworkUnreachable = errors.New("network unreachable: database host or port is invalid or down")
	ErrTimeout            = errors.New("connection timeout: failed to connect to database in time")
	ErrTLSFailed          = errors.New("tls verification failed: SSL/TLS settings are invalid")
)
