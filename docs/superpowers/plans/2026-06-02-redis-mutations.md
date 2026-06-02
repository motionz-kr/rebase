# Redis write operations (engine) — Plan

**Goal:** Add Redis key mutations to the engine (issues #1/#2/#3 of the Redis milestone):
SET (string), DEL, EXPIRE/PERSIST (TTL), RENAME — plus honor the DB-index in connect().

**Architecture:** Extend the existing `RedisConnector` port + go-redis adapter, add HTTP
routes and IPC. Verified by integration tests against local Redis (6379) + go build.

## Tasks
- RM-1 (TDD): integration test `TestRedisConnector_Mutations` — RED (methods missing).
- RM-2: adapter — `SetString`, `DeleteKey`, `SetTTL`, `RenameKey`; use DB index in connect()/TestConnection.
- RM-3: `RedisConnector` interface + transport handlers + routes (`/redis/set|del|expire|rename`).
- RM-4: IPC (`redisSet/redisDelete/redisExpire/redisRename`) + preload + global.d.ts.
- RM-5: Verify — `go test ./internal/adapters/redis/` GREEN + `go build ./...` + tsc.
