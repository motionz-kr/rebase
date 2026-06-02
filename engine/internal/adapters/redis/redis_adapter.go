package redis

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	redisDriver "github.com/redis/go-redis/v9"
	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type RedisConnector struct{}

func NewRedisConnector() *RedisConnector {
	return &RedisConnector{}
}

func (c *RedisConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	opts := &redisDriver.Options{
		Addr:        fmt.Sprintf("%s:%d", p.Host, p.Port),
		Username:    p.Username,
		Password:    password,
		DB:          redisDB(p),
		DialTimeout: 2 * time.Second,
	}

	if p.TLSMode == "require" || p.TLSMode == "prefer" {
		opts.TLSConfig = &tls.Config{
			InsecureSkipVerify: true,
		}
	}

	client := redisDriver.NewClient(opts)
	defer client.Close()

	err := client.Ping(ctx).Err()
	if err != nil {
		return c.normalizeError(err)
	}

	return nil
}

func (c *RedisConnector) normalizeError(err error) error {
	if err == nil {
		return nil
	}

	errStr := err.Error()

	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return adapters.ErrTimeout
	}

	if strings.Contains(errStr, "connection refused") || strings.Contains(errStr, "no such host") || strings.Contains(errStr, "i/o timeout") {
		return adapters.ErrNetworkUnreachable
	}

	if strings.Contains(errStr, "NOAUTH") || strings.Contains(errStr, "ERR Client sent AUTH") || strings.Contains(errStr, "WRONGPASS") || strings.Contains(errStr, "invalid password") {
		return adapters.ErrAuthFailed
	}

	if strings.Contains(errStr, "tls") || strings.Contains(errStr, "certificate") || strings.Contains(errStr, "ssl") {
		return adapters.ErrTLSFailed
	}

	return err
}
func (c *RedisConnector) connect(p domain.ConnectionProfile, password string) (*redisDriver.Client, error) {
	opts := &redisDriver.Options{
		Addr:        fmt.Sprintf("%s:%d", p.Host, p.Port),
		Username:    p.Username,
		Password:    password,
		DB:          redisDB(p),
		DialTimeout: 5 * time.Second,
	}

	if p.TLSMode == "require" || p.TLSMode == "prefer" {
		opts.TLSConfig = &tls.Config{
			InsecureSkipVerify: true,
		}
	}

	return redisDriver.NewClient(opts), nil
}

// redisDB parses the profile's Database field as the Redis logical DB index
// (0–15, default 0).
func redisDB(p domain.ConnectionProfile) int {
	if n, err := strconv.Atoi(strings.TrimSpace(p.Database)); err == nil && n >= 0 {
		return n
	}
	return 0
}

// SetString sets a string value, preserving any existing TTL (KEEPTTL).
func (c *RedisConnector) SetString(ctx context.Context, p domain.ConnectionProfile, password string, key string, value string) error {
	client, err := c.connect(p, password)
	if err != nil {
		return err
	}
	defer client.Close()
	return c.normalizeError(client.Set(ctx, key, value, redisDriver.KeepTTL).Err())
}

// DeleteKey removes a key; the bool reports whether the key existed.
func (c *RedisConnector) DeleteKey(ctx context.Context, p domain.ConnectionProfile, password string, key string) (bool, error) {
	client, err := c.connect(p, password)
	if err != nil {
		return false, err
	}
	defer client.Close()
	n, err := client.Del(ctx, key).Result()
	if err != nil {
		return false, c.normalizeError(err)
	}
	return n > 0, nil
}

// SetTTL sets the key's expiry in seconds; a negative value clears it (PERSIST).
func (c *RedisConnector) SetTTL(ctx context.Context, p domain.ConnectionProfile, password string, key string, seconds int64) error {
	client, err := c.connect(p, password)
	if err != nil {
		return err
	}
	defer client.Close()
	if seconds < 0 {
		return c.normalizeError(client.Persist(ctx, key).Err())
	}
	return c.normalizeError(client.Expire(ctx, key, time.Duration(seconds)*time.Second).Err())
}

// RenameKey renames a key (RENAME); fails if the source key is missing.
func (c *RedisConnector) RenameKey(ctx context.Context, p domain.ConnectionProfile, password string, key string, newKey string) error {
	client, err := c.connect(p, password)
	if err != nil {
		return err
	}
	defer client.Close()
	return c.normalizeError(client.Rename(ctx, key, newKey).Err())
}

// RunCommand executes an arbitrary Redis command (the console). A Redis-level
// error (e.g. WRONGTYPE) is returned as a result with IsError=true rather than
// a transport error, so the console can display it inline; only connection-level
// failures surface as an error.
func (c *RedisConnector) RunCommand(ctx context.Context, p domain.ConnectionProfile, password string, args []string) (ports.RedisCommandResult, error) {
	if len(args) == 0 {
		return ports.RedisCommandResult{Output: "(empty command)", IsError: true}, nil
	}
	client, err := c.connect(p, password)
	if err != nil {
		return ports.RedisCommandResult{}, err
	}
	defer client.Close()

	ifaceArgs := make([]interface{}, len(args))
	for i, a := range args {
		ifaceArgs[i] = a
	}

	val, err := client.Do(ctx, ifaceArgs...).Result()
	if err != nil {
		// A nil reply (e.g. GET on a missing key) is not an error for a console.
		if errors.Is(err, redisDriver.Nil) {
			return ports.RedisCommandResult{Output: "(nil)"}, nil
		}
		// Redis-level command errors implement redisDriver.Error; show inline.
		var rErr redisDriver.Error
		if errors.As(err, &rErr) {
			return ports.RedisCommandResult{Output: err.Error(), IsError: true}, nil
		}
		// Anything else is a connection/transport failure.
		return ports.RedisCommandResult{}, c.normalizeError(err)
	}
	return ports.RedisCommandResult{Output: formatRedisReply(val)}, nil
}

// formatRedisReply renders a go-redis reply value in a redis-cli-like style.
func formatRedisReply(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "(nil)"
	case string:
		return t
	case []byte:
		return string(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "1"
		}
		return "0"
	case []interface{}:
		if len(t) == 0 {
			return "(empty array)"
		}
		parts := make([]string, len(t))
		for i, e := range t {
			// Indent nested element lines so multi-line replies stay readable.
			inner := strings.ReplaceAll(formatRedisReply(e), "\n", "\n   ")
			parts[i] = fmt.Sprintf("%d) %s", i+1, inner)
		}
		return strings.Join(parts, "\n")
	default:
		return fmt.Sprintf("%v", t)
	}
}

func (c *RedisConnector) ScanKeys(ctx context.Context, p domain.ConnectionProfile, password string, pattern string, cursor uint64, count int64) (ports.RedisKeyspaceInfo, error) {
	client, err := c.connect(p, password)
	if err != nil {
		return ports.RedisKeyspaceInfo{}, err
	}
	defer client.Close()

	if count <= 0 {
		count = 100
	}

	keys, nextCursor, err := client.Scan(ctx, cursor, pattern, count).Result()
	if err != nil {
		return ports.RedisKeyspaceInfo{}, c.normalizeError(err)
	}

	return ports.RedisKeyspaceInfo{
		Keys:   keys,
		Cursor: nextCursor,
	}, nil
}

func (c *RedisConnector) GetKeyValue(ctx context.Context, p domain.ConnectionProfile, password string, key string) (ports.RedisValueInfo, error) {
	client, err := c.connect(p, password)
	if err != nil {
		return ports.RedisValueInfo{}, err
	}
	defer client.Close()

	keyType, err := client.Type(ctx, key).Result()
	if err != nil {
		return ports.RedisValueInfo{}, c.normalizeError(err)
	}

	// Redis TYPE returns "none" for a missing key. Report it as a clean
	// not-found result instead of an "unsupported type" value.
	if keyType == "none" {
		return ports.RedisValueInfo{Type: "none", Exists: false, TTL: -2}, nil
	}

	ttlDuration, err := client.TTL(ctx, key).Result()
	if err != nil {
		return ports.RedisValueInfo{}, c.normalizeError(err)
	}
	// go-redis returns the sentinels -1 (no expiry) and -2 (missing) as raw
	// negative nanosecond durations, so converting via Seconds() truncates them
	// to 0. Pass those through as-is; only real expiries get second precision.
	ttlSeconds := int64(ttlDuration.Seconds())
	if ttlDuration < 0 {
		ttlSeconds = int64(ttlDuration)
	}

	const collectionPreviewLimit = 100
	truncated := false

	var formattedValue string
	switch keyType {
	case "string":
		val, err := client.Get(ctx, key).Result()
		if err != nil {
			return ports.RedisValueInfo{}, c.normalizeError(err)
		}
		formattedValue = val

	case "list":
		vals, err := client.LRange(ctx, key, 0, collectionPreviewLimit-1).Result()
		if err != nil {
			return ports.RedisValueInfo{}, c.normalizeError(err)
		}
		if len(vals) == collectionPreviewLimit {
			truncated = true
		}
		data, _ := json.Marshal(vals)
		formattedValue = string(data)

	case "set":
		vals, err := client.SMembers(ctx, key).Result()
		if err != nil {
			return ports.RedisValueInfo{}, c.normalizeError(err)
		}
		data, _ := json.Marshal(vals)
		formattedValue = string(data)

	case "zset":
		vals, err := client.ZRangeWithScores(ctx, key, 0, collectionPreviewLimit-1).Result()
		if err != nil {
			return ports.RedisValueInfo{}, c.normalizeError(err)
		}
		if len(vals) == collectionPreviewLimit {
			truncated = true
		}
		type zElement struct {
			Member string  `json:"member"`
			Score  float64 `json:"score"`
		}
		var elements []zElement
		for _, v := range vals {
			elements = append(elements, zElement{
				Member: fmt.Sprintf("%v", v.Member),
				Score:  v.Score,
			})
		}
		data, _ := json.Marshal(elements)
		formattedValue = string(data)

	case "hash":
		vals, err := client.HGetAll(ctx, key).Result()
		if err != nil {
			return ports.RedisValueInfo{}, c.normalizeError(err)
		}
		data, _ := json.Marshal(vals)
		formattedValue = string(data)

	default:
		formattedValue = fmt.Sprintf("Unsupported or complex key type: %s", keyType)
	}

	return ports.RedisValueInfo{
		Type:      keyType,
		Value:     formattedValue,
		TTL:       ttlSeconds,
		Exists:    true,
		Truncated: truncated,
	}, nil
}

type RedisAdapter = RedisConnector
