# ADR 0004: Result Streaming and Cancellation

## Status

Accepted

## Context

SQL query execution은 result size, renderer grid 성능, cancellation, timeout, row limit이 서로 얽혀 있다.

단순히 engine에서 전체 result를 메모리에 담아 JSON으로 반환하면 구현은 쉽지만, 큰 result set에서 memory pressure와 renderer freeze가 발생한다. 반대로 streaming을 도입하면 protocol, backpressure, cancellation semantics를 먼저 결정해야 한다.

## Decision

초기 result streaming protocol은 NDJSON over local HTTP로 시작한다.

기본 정책:

- 일반 query는 default row limit을 적용한다.
- large result fetch는 사용자가 명시적으로 선택해야 한다.
- engine은 전체 result set을 메모리에 버퍼링하지 않는다.
- stream은 metadata event, row event, progress event, error event, end event로 구성한다.
- cancellation은 stream close와 driver-specific query cancellation을 모두 수행한다.

Event 예시:

```json
{"type":"metadata","queryId":"q_123","columns":[{"name":"id","type":"int"}]}
{"type":"row","queryId":"q_123","values":[1]}
{"type":"progress","queryId":"q_123","rows":1000}
{"type":"end","queryId":"q_123","rows":1000}
```

## Backpressure

Renderer grid가 처리하지 못하는 속도로 row가 도착하면 streaming의 의미가 사라진다.

초기 backpressure 규칙:

- Go engine은 DB cursor 또는 row iterator에서 chunk 단위로 읽는다.
- Electron main process는 HTTP response body를 필요한 만큼만 읽는다.
- Electron main process가 response body read를 늦추면 TCP flow control을 통해 Go engine write가 자연스럽게 느려진다.
- renderer 전달 구간에는 필요할 때 별도 app-level ack를 둘 수 있지만, Go engine throttle의 기본 메커니즘으로 요구하지 않는다.
- chunk size는 성능 테스트로 조정하되 기본값은 작게 시작한다.

## Cancellation

`SQLConnector.Cancel(queryID)`는 공통 port지만 adapter별 구현이 다르다.

- PostgreSQL: driver의 cancellation mechanism을 사용한다.
- MySQL: query가 실행 중인 connection/session id를 추적하고 별도 connection에서 kill command를 실행한다.

따라서 engine은 `queryID -> driver session` mapping을 추적한다. Stream close만으로 cancellation이 완료되었다고 판단하지 않는다.

## Consequences

장점:

- 큰 result set에서 engine memory 사용량을 통제할 수 있다.
- renderer grid와 transport 사이에 backpressure를 설계할 수 있다.
- cancellation behavior를 adapter contract test로 검증할 수 있다.

단점:

- 단순 REST JSON보다 구현이 복잡하다.
- Electron main process가 stream proxy와 backpressure를 관리해야 한다.
- cancellation contract test가 DB별로 까다롭다.

## Follow-up

- NDJSON event schema를 OpenAPI 또는 별도 schema 문서로 고정한다.
- PostgreSQL/MySQL cancellation contract test는 Phase 4 안에서 구현 전에 먼저 작성한다.
- 50,000 row fixture를 기준으로 memory와 renderer long task 성능을 측정한다.
