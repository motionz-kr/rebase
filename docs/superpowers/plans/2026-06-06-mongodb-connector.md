# MongoDB Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-06-mongodb-connector-design.md`. Tracking issue: #106.

**Goal:** Add MongoDB as a fully-featured connectable database (browse, query, CRUD, indexes, schema inference) following the Redis precedent — a dedicated connector + dedicated renderer components, NOT the relational SQLConnector/SQL-builder/MCP machinery.

**Architecture:** New `MongoConnector` port + `engine/internal/adapters/mongo` (driver `go.mongodb.org/mongo-driver/v2`). Documents are exchanged as relaxed **Extended JSON** strings. A dedicated `MongoHandler` exposes `/mongo/*` routes. The renderer parses mongosh **read** commands client-side and renders a Mongo-specific UI (`driver === 'mongodb'` branch in App.tsx).

**Tech Stack:** Go 1.25 (`/Users/smlee/sdk/go/bin/go`), `go.mongodb.org/mongo-driver/v2`, React 19 + Vite, Electron 28, Docker `mongo:latest` (arm64 native) for integration tests.

**Conventions:** Branch `feat/mongodb-connector` (already created). Conventional Commits; co-author trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Engine tests from `engine/`.

**Live test server (integration tasks):** Docker mongo at `localhost:27017` with root auth. Start:
```bash
docker run -d --name rebase-mongo -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD='password1!' -p 27017:27017 mongo:latest
```
Integration tests read `MONGO_TEST_URI` (e.g. `mongodb://root:password1!@localhost:27017/?authSource=admin`) and **skip** when unset, like the other engines' integration tests.

**mongo-driver/v2 API quick reference** (verify against the live server; tests are the arbiter):
- Connect: `client, err := mongo.Connect(options.Client().ApplyURI(uri))` (v2 `Connect` takes options, NOT a context). `defer client.Disconnect(ctx)`. `client.Ping(ctx, nil)`.
- `client.ListDatabaseNames(ctx, bson.D{})`; `client.Database(db).ListCollectionNames(ctx, bson.D{})`.
- Parse ext-JSON arg: `var f bson.D; bson.UnmarshalExtJSON([]byte(jsonStr), false, &f)` (empty string → `bson.D{}`).
- Find: `cur, _ := coll.Find(ctx, filter, options.Find().SetSort(sort).SetProjection(proj).SetSkip(skip).SetLimit(limit))`; iterate `for cur.Next(ctx) { ext, _ := bson.MarshalExtJSON(cur.Current, false, false); docs = append(docs, string(ext)) }`.
- Aggregate: `coll.Aggregate(ctx, pipeline)` where `var pipeline bson.A; bson.UnmarshalExtJSON([]byte(pipelineJSON), false, &pipeline)`.
- `coll.CountDocuments(ctx, filter)`; `coll.InsertOne(ctx, doc)` (doc is `bson.D`); `coll.ReplaceOne(ctx, bson.D{{"_id", id}}, doc)`; `coll.DeleteOne(ctx, bson.D{{"_id", id}})`.
- Indexes: `coll.Indexes().List(ctx)`, `coll.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: keys, Options: options.Index().SetUnique(u).SetName(n)})`, `coll.Indexes().DropOne(ctx, name)`.
- Schema sample: `coll.Aggregate(ctx, bson.A{bson.D{{"$sample", bson.D{{"size", n}}}}})`.

---

## Phase M-E: Engine

### Task M-E1: Domain — accept `mongodb` + `ConnectionURI` field + migration v5

**Files:** `engine/internal/domain/connection.go` (+test); `engine/cmd/app-engine/main.go`; `engine/internal/adapters/sqlite/sqlite_profile_repository.go` (+ its test); `engine/internal/application/integration_persistence_test.go`.

- [ ] **Step 1 (TDD):** add to `connection_test.go`:
```go
func TestValidate_MongoStructured(t *testing.T) {
	p := ConnectionProfile{Name: "m", Driver: "mongodb", Host: "h", Port: 27017}
	if err := p.Validate(); err != nil { t.Fatalf("structured mongo should be valid: %v", err) }
}
func TestValidate_MongoConnectionURI(t *testing.T) {
	p := ConnectionProfile{Name: "m", Driver: "mongodb", ConnectionURI: "mongodb+srv://x/y"}
	if err := p.Validate(); err != nil { t.Fatalf("uri mongo should be valid: %v", err) }
}
func TestValidate_MongoNeedsHostOrURI(t *testing.T) {
	if (ConnectionProfile{Name: "m", Driver: "mongodb"}).Validate() == nil {
		t.Fatal("mongo with neither host nor uri should be invalid")
	}
}
```
- [ ] **Step 2:** Run → FAIL (`unsupported database driver: mongodb`).
- [ ] **Step 3:** In `connection.go`: add `ConnectionURI string \`json:"connectionUri"\`` to the struct. In `Validate()`: add `mongodb` to the driver allow-list; add a branch BEFORE the generic Host/Port checks:
```go
	if p.Driver == "mongodb" {
		if p.ConnectionURI == "" && (p.Host == "" || p.Port <= 0 || p.Port > 65535) {
			return errors.New("mongodb requires either a connection URI or host+port")
		}
		return nil
	}
```
- [ ] **Step 4:** Migration v5 in `main.go` migrations slice (after v4): `ALTER TABLE connection_profiles ADD COLUMN connection_uri TEXT NOT NULL DEFAULT '';` (Checksum `profile-connection-uri-v1`).
- [ ] **Step 5:** In `sqlite_profile_repository.go`, add `connection_uri` to Create/Update/GetByID/List column lists + `p.ConnectionURI`/`&p.ConnectionURI` at the matching position (after `read_only`, before `created_at`). Add the column to the test helper's inline schema. Add `connection_uri TEXT NOT NULL DEFAULT ''` to the inline schema in `internal/application/integration_persistence_test.go` (the third schema copy — a known gotcha).
- [ ] **Step 6:** Run `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/domain/ ./internal/adapters/sqlite/ ./internal/application/` → PASS. `gofmt`, `go build ./...`.
- [ ] **Step 7: Commit** `feat(engine): accept mongodb driver + ConnectionURI (migration v5)`.

### Task M-E2: MongoConnector port + adapter — connect, list dbs/collections, URI builder

**Files:** Create `engine/internal/ports/mongo_connector.go`; `engine/internal/adapters/mongo/mongo_uri.go` (+test), `mongo_connector.go`, `mongo_connector_test.go`. Modify `go.mod`.

- [ ] **Step 1:** `cd engine && /Users/smlee/sdk/go/bin/go get go.mongodb.org/mongo-driver/v2@latest && go mod tidy`.
- [ ] **Step 2:** Create the port `engine/internal/ports/mongo_connector.go` with the full `MongoConnector` interface + structs (`CollectionInfo`, `MongoResult{Documents []string; Total int64}`, `MongoIndex{Name string; Keys string; Unique bool}`, `MongoField{Path string; Types []string; Presence float64}`) per the spec §2. (Declaring the whole interface now is fine even though later tasks implement more methods — but to keep the package compiling, EITHER declare only the methods implemented so far OR implement stubs. DECISION: declare the FULL interface now; implement all methods across M-E2..M-E5; do NOT add `var _ ports.MongoConnector` until M-E5 so partial builds work. The connector's methods are added incrementally; Go compiles a type that doesn't yet satisfy an interface as long as nothing asserts it.)
- [ ] **Step 3 (TDD hermetic):** `mongo_uri_test.go`:
```go
func TestBuildMongoURI_Structured(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", Host: "h", Port: 27017, Username: "u"}
	got := BuildMongoURI(p, "p@ss")
	if !strings.HasPrefix(got, "mongodb://u:p%40ss@h:27017/") || !strings.Contains(got, "authSource=admin") {
		t.Fatalf("got %q", got)
	}
}
func TestBuildMongoURI_Override(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", ConnectionURI: "mongodb+srv://a/b"}
	if BuildMongoURI(p, "") != "mongodb+srv://a/b" { t.Fatal("uri override should win") }
}
func TestBuildMongoURI_NoAuth(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "mongodb", Host: "h", Port: 27017}
	if strings.Contains(BuildMongoURI(p, ""), "@") { t.Fatal("no userinfo when username empty") }
}
```
- [ ] **Step 4:** Implement `mongo_uri.go`: `BuildMongoURI(p, password)` — if `p.ConnectionURI != ""` return it; else build via `net/url` with `authSource=admin&serverSelectionTimeoutMS=5000`, userinfo only when `Username != ""`.
- [ ] **Step 5 (TDD integration):** `mongo_connector_test.go` — a `mongoProfile(t)` skip-guard helper (reads `MONGO_TEST_URI`, sets `ConnectionURI` on the profile) + a `seedMongo(t, c)` helper that inserts into `rebase_test` DB, `people` + `orders` collections, a few docs, and an index. Tests `TestMongo_TestConnection`, `TestMongo_ListDatabases` (includes rebase_test), `TestMongo_ListCollections` (people, orders).
- [ ] **Step 6:** Implement `mongo_connector.go`: `MongoConnector struct{}` + `NewMongoConnector()`; `client(p, password) (*mongo.Client, error)` using `BuildMongoURI`; `TestConnection` (Ping); `ListDatabases` (filter out admin/local/config? — keep all but order; the test only checks rebase_test is present); `ListCollections(db)`; `normalizeError`. Always `defer client.Disconnect(ctx)`.
- [ ] **Step 7:** Run integration tests (with `MONGO_TEST_URI` set) → PASS; SKIP without. `gofmt`, `go vet`, `go build ./...`. **Commit** `feat(engine): mongo connector — connect + list dbs/collections + uri builder`.

### Task M-E3: Queries — Find, Aggregate, CountDocuments

**Files:** `mongo_connector.go`, `mongo_connector_test.go`.
- [ ] **Step 1 (TDD integration):** tests asserting: `Find(rebase_test, people, filter, sort, proj, skip, limit)` returns the expected document count + the docs are valid ext-JSON containing expected fields; `Aggregate` with `[{$match...},{$group...}]` returns grouped results; `CountDocuments` returns the right number.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `Find`/`Aggregate`/`CountDocuments` per the API reference (parse ext-JSON args to `bson.D`/`bson.A`; marshal each result doc with `bson.MarshalExtJSON(cur.Current, false, false)`). Empty filter string → `bson.D{}`. `MongoResult.Total` = `CountDocuments(filter)` for find (so the UI can paginate), or `-1` for aggregate.
- [ ] **Step 4:** Run → PASS. `gofmt`, build. **Commit** `feat(engine): mongo connector — find/aggregate/count`.

### Task M-E4: Document CRUD — Insert, Replace, Delete

**Files:** `mongo_connector.go`, `mongo_connector_test.go`.
- [ ] **Step 1 (TDD):** round-trip tests — Insert a doc (assert returned insertedID), Find it back; Replace by _id (assert updated field); Delete by _id (assert gone). `idJSON` is an ext-JSON scalar like `{"$oid":"..."}` or a plain value; parse with `bson.UnmarshalExtJSON` into an `interface{}`/`bson.RawValue` and use as `_id`.
- [ ] **Step 2-4:** Implement `InsertDocument`/`ReplaceDocument`/`DeleteDocument`; run → PASS; **Commit** `feat(engine): mongo connector — document CRUD`.

### Task M-E5: Indexes + schema inference + interface assertion

**Files:** `mongo_connector.go`, `mongo_connector_test.go`.
- [ ] **Step 1 (TDD):** tests — `ListIndexes` returns the seeded index + the default `_id_`; `CreateIndex` then `ListIndexes` shows it; `DropIndex` removes it; `InferSchema(rebase_test, people, 100)` returns fields with types + presence (e.g. `name`→[string], `age`→[int]).
- [ ] **Step 2-3:** Implement `ListIndexes` (marshal each index spec; `Keys` as ext-JSON; `Unique` from the index doc), `CreateIndex` (parse `keysJSON` to `bson.D`), `DropIndex`, `InferSchema` ($sample + walk top-level + one nested level, accumulate type set + presence). Add `var _ ports.MongoConnector = (*MongoConnector)(nil)` (now the full interface must be satisfied — fix any signature mismatch).
- [ ] **Step 4:** Run full mongo package → PASS; `go build ./...`. **Commit** `feat(engine): mongo connector — indexes + schema inference`.

### Task M-E6: HTTP MongoHandler + routes + profile registration

**Files:** Create `engine/internal/transport/http/mongo.go`; modify `engine/cmd/app-engine/main.go`, `engine/internal/transport/http/profile.go`.
- [ ] **Step 1:** Create `MongoHandler` (mirror `redis.go`'s structure: token check, resolve profile+password via the connection service, one `http.Handler` per endpoint OR a `Routes()` mux). Implement the 12 routes from spec §3. Each decodes a JSON body, calls the connector, writes JSON.
- [ ] **Step 2:** In `main.go`: construct `mongoHandler := internalHttp.NewMongoHandler(*token, connectionService)` and `mux.Handle("/mongo/", mongoHandler.Routes())`.
- [ ] **Step 3:** In `profile.go` `TestConnection` switch: add `case "mongodb": err = h.mongoConnector.TestConnection(...)` (+ a `mongoConnector` field + import + constructor).
- [ ] **Step 4:** `go build ./... && go test ./...` (mongo integration skips without env). `gofmt`. **Commit** `feat(engine): mongo HTTP handler + routes + profile test-connection`.

## Phase M-R: Renderer

### Task M-R1: IPC + types

**Files:** `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts`.
- [ ] Add 12 `mongo*` IPC handlers in main (each `engineRequest('POST', '/mongo/...', body)`), expose in preload, type in `global.d.ts`. Add `'mongodb'` to `ConnectionProfile.driver`, `connectionUri?: string`, and the `MongoDocumentResult`/`MongoIndexInfo`/`MongoFieldInfo` types. `cd apps/desktop && npx tsc`; `cd apps/renderer && npx tsc --noEmit`. **Commit** `feat(desktop): mongo IPC + renderer types`.

### Task M-R2: mongosh read-command parser + doc helpers (TDD)

**Files:** Create `apps/renderer/src/lib/mongoQuery.ts` (+test), `mongoDoc.ts` (+test).
- [ ] **Step 1 (TDD):** `mongoQuery.test.ts` — `parseMongoCommand('db.people.find({age:{$gt:20}}).sort({age:-1}).limit(10)')` → `{collection:'people', op:'find', filter:'{"age":{"$gt":20}}', sort:'{"age":-1}', limit:10}`; aggregate → `{op:'aggregate', pipeline:'[...]'}`; `countDocuments` → `{op:'count', filter}`; a write command (`insertOne`) → `{error: <friendly>}`; malformed → `{error}`. `mongoDoc.test.ts` — `flattenDocument` (top-level keys → columns, nested → JSON string), `formatExtJson` (pretty).
- [ ] **Step 2-3:** Implement. The parser: regex/scan `db.<ident>.<op>(<args>)` + optional `.sort(...).skip(...).limit(...).project(...)` chain; parse each `(...)` arg with a relaxed-JSON→JSON normalizer (allow unquoted keys, single quotes) then `JSON.parse` to validate, re-stringify canonical. Reject non-read ops with a clear message.
- [ ] **Step 4:** Run the two suites + full `vitest run` → PASS; `tsc`, `eslint`. **Commit** `feat(renderer): mongosh read-command parser + document helpers`.

### Task M-R3: Connection form — mongodb option (structured + connectionUri)

**Files:** `apps/renderer/src/App.tsx`, `App.css`, `global.d.ts` (driver union already done in M-R1).
- [ ] Add `formConnectionUri` state; `DRIVER_LABEL` `mongodb: 'MG'`; `<option value="mongodb">MongoDB</option>`; `handleDriverChange('mongodb')` → port 27017, clear database. In the form body, mongodb renders the standard host/port/user/password fields PLUS an "고급: 연결 문자열 (선택)" input bound to `formConnectionUri` (when non-empty, show a hint that it overrides host/port). Include `connectionUri: formConnectionUri` in the built profile; load it in `startEdit`/clear in `resetForm`. `tsc/eslint/vitest/build`. **Commit** `feat(renderer): mongodb connection form`.

### Task M-R4: MongoExplorer + App.tsx branch

**Files:** Create `apps/renderer/src/components/MongoExplorer.tsx`; modify `App.tsx` (+CSS).
- [ ] `MongoExplorer`: DB → collections tree (lazy load via `mongoDatabases`/`mongoCollections`), context menus (collection: 문서 보기/쿼리/인덱스/스키마/삭제; db: 컬렉션 만들기). `App.tsx`: when `driver === 'mongodb'`, render `MongoExplorer` in the tree area and the Mongo main pane (query editor / document view) — mirror the Redis branch. `tsc/eslint/vitest/build`. **Commit** `feat(renderer): MongoExplorer + mongodb app branch`.

### Task M-R5: MongoDocumentView (browse + CRUD)

**Files:** Create `apps/renderer/src/components/MongoDocumentView.tsx`, `MongoDocEditor.tsx`; CSS.
- [ ] Document view for a collection: JSON filter bar + skip/limit pagination (via `mongoFind`/`mongoCount`), grid ↔ JSON toggle (using `mongoDoc` helpers), per-doc 편집/삭제 + 문서 추가. `MongoDocEditor` is a JSON-validating modal for insert/replace (`mongoInsert`/`mongoReplace`). Delete via `mongoDelete`. `tsc/eslint/vitest/build`. **Commit** `feat(renderer): Mongo document view + CRUD`.

### Task M-R6: MongoQueryEditor + IndexManager + SchemaPanel

**Files:** Create `MongoQueryEditor.tsx`, `MongoIndexManager.tsx`, `MongoSchemaPanel.tsx`; wire into App/MongoExplorer.
- [ ] `MongoQueryEditor`: Monaco editor; on run, `parseMongoCommand` → `mongoFind`/`mongoAggregate`/`mongoCount`; results into the document view/grid; parser errors inline. `MongoIndexManager`: list/create/drop (`mongoIndexes`/`mongoCreateIndex`/`mongoDropIndex`). `MongoSchemaPanel`: `mongoSchema` → field/type/presence table. `tsc/eslint/vitest/build`. **Commit** `feat(renderer): Mongo query editor + index manager + schema panel`.

## Phase M-V: Verify

### Task M-V1: Full build + live CDP verification
- [ ] **Step 1:** Engine `go build ./... && MONGO_TEST_URI=... go test ./...`; renderer `tsc --noEmit && eslint src && vitest run && pnpm build`; desktop `tsc`.
- [ ] **Step 2:** Ensure Docker mongo is up + seed a demo DB (people/orders + docs + index).
- [ ] **Step 3:** Launch dev app with `--remote-debugging-port=9222` (build engine binary to `apps/desktop/bin/app-engine` first).
- [ ] **Step 4:** CDP live: create a mongodb connection (structured: localhost:27017, root/password1!), connect, browse DBs/collections, open a collection (filter + paginate, toggle grid/JSON), run a `find` and an `aggregate` from the query editor, insert/edit/delete a document, list/create an index, infer schema. Screenshot.
- [ ] **Step 5:** Tear down: kill electron/vite; `docker rm -f rebase-mongo`. Commit any fixes.

## Self-Review (completed during planning)

- **Spec coverage:** §1 model → M-E1; §2 connector → M-E2..M-E5 (uri builder, connect/list, queries, CRUD, indexes, schema); §3 HTTP → M-E6; §4 renderer → M-R1 (IPC/types) + M-R2 (parser) + M-R3 (form) + M-R4..R6 (components); §6 testing → integration tests per task + unit (parser/uri) + M-V1.
- **Type consistency:** `MongoConnector`/`NewMongoConnector`, `BuildMongoURI`, `MongoResult`/`MongoIndex`/`MongoField`, `parseMongoCommand`, `MONGO_TEST_URI`, `connection_uri`/`ConnectionURI`/`connectionUri` used consistently across engine/IPC/renderer.
- **Known soft spots flagged:** mongo-driver/v2 `Connect` signature + exact bson ext-JSON calls are pinned by live integration TDD; the mongosh parser's relaxed-JSON handling is pinned by unit tests; the third profile-schema copy (integration_persistence_test.go) is called out in M-E1.
