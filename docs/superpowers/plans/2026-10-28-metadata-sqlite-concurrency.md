# Metadata SQLite concurrency

MySQL table creation can fail before its SQL reaches MySQL when profile reads
race with query-history/profile/activity writes to the app's metadata SQLite.
The engine currently opens metadata with an unlimited pool, rollback journal,
and no busy timeout. Raw SQLITE_BUSY escapes through the profile lookup.

Open the engine-owned metadata database through a dedicated adapter factory:
WAL, per-connection busy_timeout(5000), and one retained pooled connection per
engine. WAL permits reader/writer overlap across the desktop and MCP engines;
the bounded pool serializes each engine's short metadata operations. Preserve
normal synchronous durability and fail explicitly after the bounded wait. Do
not retry or alter user SQL, change user database pragmas, or delete metadata.

TDD: reproduce the old reader/writer conflict and verify WAL reader snapshots,
parallel writes from separate handles, timeout on replacement connections,
special-character paths, and migration compatibility with a one-connection
pool. Add Electron E2E that creates disposable MySQL e2e_* tables while many
history writes execute through the real preload/HTTP/repository path. Confirm
the tables in MySQL and metadata history without touching personal databases.
