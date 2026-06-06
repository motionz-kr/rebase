# MongoDB Connector — Design

**Milestone:** #5 Database engine expansion (Epic #34) — third sub-project (after SQLite v0.13.0, SQL Server v0.14.0). **Tracking issue:** #106.

**Goal:** Make MongoDB a connectable database with **full features**: connect, browse databases → collections, view/paginate documents, run `find`/`aggregate` queries, document CRUD (insert/edit/delete), index management, and schema inference.

**Key premise:** MongoDB is a **document store**, not relational. It has no SQL, tables, DDL, or foreign keys, so it does **not** reuse the `SQLConnector` interface, the SQL builders, the schema/ER machinery, or MCP. It follows the **Redis precedent**: a dedicated connector interface + a dedicated set of renderer components, with `App.tsx` branching on `driver === 'mongodb'` to render the Mongo UI instead of the relational SchemaExplorer/QueryEditor.

---

## Decisions (locked via brainstorming)

1. **Full features** — browse + query (find/aggregate) + document CRUD + index management + schema inference.
2. **Both connection methods** — structured (host/port/user/password) AND an advanced connection-string (`connectionUri`) field for `mongodb://` / `mongodb+srv://` (Atlas SRV, replica sets, TLS, custom authSource).
3. **UX** — browse tree (DB → collections) + a mongosh-style read query editor (Monaco) + a document view (filter bar + pagination, grid/JSON toggle). Mirrors the relational app's layout.
4. **Driver:** `go.mongodb.org/mongo-driver/v2` (official, pure Go, ARM-compatible). Driver string `"mongodb"`.
5. **Not in MCP** (same as Redis).
6. **Testing:** Docker mongo (`mongo:latest`, arm64 native) integration tests, gated on `MONGO_TEST_URI` (skip when unset). Renderer unit tests for the mongosh parser + Extended JSON display. CDP live verification.

---

## 1. Data model

`engine/internal/domain/connection.go`
- Add field `ConnectionURI string` with JSON tag `connectionUri` to `ConnectionProfile` (the advanced connection-string override; empty in structured mode).
- `Validate()`: add a `mongodb` branch — require **either** `ConnectionURI` non-empty **or** (`Host` non-empty AND `Port` in 1..65535). `Database` is optional for mongodb (used as the default browsing database / authSource hint; mongo can connect without one).

`engine/cmd/app-engine/main.go` migrations + `engine/internal/adapters/sqlite/sqlite_profile_repository.go`
- Migration **v5**: `ALTER TABLE connection_profiles ADD COLUMN connection_uri TEXT NOT NULL DEFAULT ''`.
- Read/write `connection_uri` ↔ `ConnectionURI` in Create/Update/GetByID/List (and update the integration-test schema copy in `internal/application/integration_persistence_test.go`, which is a known third schema copy).

## 2. Engine connector

New package `engine/internal/adapters/mongo/`:
- `mongo_connector.go` — `MongoConnector` implementing a new `ports.MongoConnector` interface.
- `mongo_uri.go` — pure helper `BuildMongoURI(profile, password) string`: if `ConnectionURI != ""` use it verbatim; else build `mongodb://<url-encoded user>:<pass>@host:port/?authSource=admin&serverSelectionTimeoutMS=5000` (omit credentials when username empty). Unit-tested.
- `mongo_connector_test.go` — integration tests (skip without `MONGO_TEST_URI`).
- `mongo_uri_test.go` — hermetic URI-builder tests.

New interface `ports.MongoConnector` (in `engine/internal/ports/connector.go` or a new `mongo_connector.go` port file):
```
TestConnection(ctx, p, password) error
ListDatabases(ctx, p, password) ([]DatabaseInfo, error)
ListCollections(ctx, p, password, database) ([]CollectionInfo, error)
Find(ctx, p, password, database, collection, filterJSON, projectionJSON, sortJSON string, skip, limit int64) (MongoResult, error)
Aggregate(ctx, p, password, database, collection, pipelineJSON string, limit int64) (MongoResult, error)
CountDocuments(ctx, p, password, database, collection, filterJSON string) (int64, error)
InsertDocument(ctx, p, password, database, collection, documentJSON string) (insertedID string, err error)
ReplaceDocument(ctx, p, password, database, collection, idJSON, documentJSON string) error
DeleteDocument(ctx, p, password, database, collection, idJSON string) error
ListIndexes(ctx, p, password, database, collection) ([]MongoIndex, error)
CreateIndex(ctx, p, password, database, collection, keysJSON string, unique bool, name string) error
DropIndex(ctx, p, password, database, collection, name string) error
InferSchema(ctx, p, password, database, collection string, sampleSize int64) ([]MongoField, error)
```
Supporting structs: `CollectionInfo{Name string}`, `MongoResult{Documents []string /* relaxed Ext-JSON */, Total int64 /* -1 if not counted */}`, `MongoIndex{Name string; Keys string /* JSON */; Unique bool}`, `MongoField{Path string; Types []string; Presence float64 /* fraction of sampled docs */}`.

**Document representation:** every document is marshalled to **relaxed Extended JSON** via `bson.MarshalExtJSONIndent` (so `ObjectId`, `Date`, etc. round-trip and the renderer gets readable JSON). Filters/pipelines/documents from the renderer are parsed with `bson.UnmarshalExtJSON` (accepts both plain JSON and Extended JSON).

**Cancellation:** per-request `ctx`; the HTTP handler derives a timeout. (No session registry — mongo ops respect context cancellation.)

**InferSchema:** run an aggregation `[{$sample:{size:N}}]`, walk each sampled doc's top-level (and one nested level) fields, accumulating the set of BSON types + presence count per field path; return sorted by presence desc.

`normalizeError`: friendly messages for auth failure, host unreachable, unknown database/collection.

## 3. HTTP transport

New `engine/internal/transport/http/mongo.go` — `MongoHandler` with token auth (mirrors `redis.go`), one route group `/mongo/*`:
- `POST /mongo/databases` {profileId} → ListDatabases
- `POST /mongo/collections` {profileId, database} → ListCollections
- `POST /mongo/find` {profileId, database, collection, filter, projection, sort, skip, limit} → MongoResult
- `POST /mongo/aggregate` {profileId, database, collection, pipeline, limit} → MongoResult
- `POST /mongo/count` {profileId, database, collection, filter} → {count}
- `POST /mongo/insert` {profileId, database, collection, document} → {insertedId}
- `POST /mongo/replace` {profileId, database, collection, id, document} → {ok}
- `POST /mongo/delete` {profileId, database, collection, id} → {ok}
- `POST /mongo/indexes` {profileId, database, collection} → [MongoIndex]
- `POST /mongo/index/create` {profileId, database, collection, keys, unique, name} → {ok}
- `POST /mongo/index/drop` {profileId, database, collection, name} → {ok}
- `POST /mongo/schema` {profileId, database, collection, sampleSize} → [MongoField]

Wire `mux.Handle("/mongo/", mongoHandler.Routes())` in `main.go`. Add a `mongodb` case to `profile.go`'s `TestConnection` switch (using the mongo connector). `getConnector` (SQL) is untouched — mongo is a separate connector type.

## 4. Renderer

### IPC (`apps/desktop/src/main/index.ts` + preload + `global.d.ts`)
Add `mongo*` IPC methods mirroring the HTTP endpoints (`mongoDatabases`, `mongoCollections`, `mongoFind`, `mongoAggregate`, `mongoCount`, `mongoInsert`, `mongoReplace`, `mongoDelete`, `mongoIndexes`, `mongoCreateIndex`, `mongoDropIndex`, `mongoSchema`) via `engineRequest`.

### Types
`global.d.ts`: `ConnectionProfile.driver` union gains `'mongodb'`; add `connectionUri?: string`; add `MongoDocumentResult`, `MongoIndexInfo`, `MongoFieldInfo` types.

### Pure logic (TDD unit-tested, no IO)
`apps/renderer/src/lib/mongoQuery.ts` — `parseMongoCommand(text): { collection, op: 'find'|'aggregate'|'count', filter?, projection?, sort?, pipeline?, skip?, limit? } | { error }`. Parses mongosh **read** commands:
`db.<coll>.find(<json>[, <json>]).sort(<json>).skip(n).limit(n)`, `db.<coll>.aggregate([<json>])`, `db.<coll>.countDocuments(<json>)`. JSON args parsed leniently (allow unquoted keys / single quotes via a relaxed-JSON pass). Writes are explicitly **not** parsed (returns a friendly "use the document view to write" error).
`apps/renderer/src/lib/mongoDoc.ts` — `flattenDocument(extJson)` (top-level fields → grid columns) and `formatExtJson(s)` (pretty-print) helpers for the grid/JSON toggle.

### Components (new)
- `MongoExplorer.tsx` — DB → collections tree (lazy-load collections per DB). Context menu per collection: 문서 보기 / 쿼리 / 인덱스 / 스키마 추론 / 컬렉션 삭제. Context menu per DB: 컬렉션 만들기.
- `MongoDocumentView.tsx` — opened for a collection: a JSON **filter bar** + pagination (skip/limit), **grid ↔ JSON toggle**, and per-document **편집/삭제** + a **문서 추가** button. Editing opens `MongoDocEditor`.
- `MongoQueryEditor.tsx` — Monaco editor for mongosh read commands; on run, `parseMongoCommand` → the matching IPC; results render in the same document view/grid.
- `MongoIndexManager.tsx` — list indexes + create (keys JSON + unique + name) + drop.
- `MongoSchemaPanel.tsx` — show inferred fields (path · types · presence).
- `MongoDocEditor.tsx` — a JSON editor modal for insert/replace (validates JSON before submit).

### App.tsx wiring
When `driver === 'mongodb'`, render the Mongo layout (MongoExplorer in the sidebar tree area + MongoQueryEditor/MongoDocumentView in the main pane) instead of SchemaExplorer/QueryEditor — exactly the branch pattern Redis uses. Connection form: a `mongodb` driver option (`DRIVER_LABEL` `MG`), structured fields (host/port 27017/user/password) **plus** an "고급: 연결 문자열" collapsible input bound to `connectionUri`; when `connectionUri` is set it takes precedence (host/port disabled/hint).

## 5. Error handling

Engine `normalizeError` maps driver errors to friendly text; surfaced through the existing error plumbing (HTTP error body → renderer toast). The mongosh parser returns structured `{error}` shown inline in the query editor.

## 6. Testing

- **Engine integration** (`mongo_connector_test.go`, skip without `MONGO_TEST_URI`): against a Docker mongo, seed a DB with two collections + a few documents + an index; assert every connector method (list dbs/collections, find with filter/sort/limit, aggregate, count, insert/replace/delete round-trip, list/create/drop index, infer schema).
- **Engine hermetic unit** (`mongo_uri_test.go`): `BuildMongoURI` structured + connectionUri-override cases.
- **Renderer unit**: `mongoQuery.test.ts` (parse find/aggregate/count + chains + error cases), `mongoDoc.test.ts` (flatten/format).
- **Live CDP**: Docker mongo — add a connection (structured), connect, browse DBs/collections, open a collection (paginate + filter), toggle grid/JSON, run a `find` and an `aggregate` from the query editor, insert/edit/delete a document, view indexes, infer schema. Screenshot.

## 7. Scope boundaries (YAGNI)

- **Not in MCP** (Redis precedent).
- Query editor parses **read** commands only (find/aggregate/count). Writes via the document-view CRUD UI.
- Schema inference samples top-level + one nested level (deep recursion deferred).
- Exotic auth/topology (Kerberos, X.509, multiple hosts) via the `connectionUri` field.
- GridFS, change streams, transactions, multi-document bulk ops — out of scope.

## File structure (new/modified)

**New — engine**
- `engine/internal/ports/mongo_connector.go` — `MongoConnector` interface + structs.
- `engine/internal/adapters/mongo/mongo_connector.go`, `mongo_uri.go`, `mongo_connector_test.go`, `mongo_uri_test.go`.
- `engine/internal/transport/http/mongo.go` — `MongoHandler`.

**Modified — engine**
- `engine/internal/domain/connection.go` (+test) — `ConnectionURI` + `mongodb` validation.
- `engine/cmd/app-engine/main.go` — migration v5 + mount `/mongo/` + construct MongoHandler.
- `engine/internal/adapters/sqlite/sqlite_profile_repository.go` (+ its test schema) and `internal/application/integration_persistence_test.go` — `connection_uri` column.
- `engine/internal/transport/http/profile.go` — `mongodb` TestConnection case.
- `go.mod` — add `go.mongodb.org/mongo-driver/v2`.

**New — renderer**
- `apps/renderer/src/lib/mongoQuery.ts` (+test), `mongoDoc.ts` (+test).
- `apps/renderer/src/components/Mongo{Explorer,DocumentView,QueryEditor,IndexManager,SchemaPanel,DocEditor}.tsx`.

**Modified — renderer/desktop**
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts` — mongo IPC + types.
- `apps/renderer/src/App.tsx` (+ `App.css`) — `mongodb` driver option + connection form + the `mongodb` render branch.
