# ADR 0001: Desktop Architecture

## Status

Accepted

## Context

이 프로젝트는 macOS와 Windows에서 동작하는 데이터베이스 데스크톱 툴을 만든다. 초기 DB 지원 범위는 MySQL, PostgreSQL, Redis다.

제품은 가벼워야 하지만, 단순한 웹앱이 아니라 설치 가능한 desktop app이어야 한다. 또한 장기적으로 account, team workspace, shared SQL, MCP settings를 지원해야 한다.

후보는 아래와 같았다.

- Electron-only
- Tauri + Rust
- Electron + React + Go local engine

## Decision

초기 아키텍처는 Electron + React + Go local engine으로 결정한다.

역할:

- Electron: desktop shell, window, menu, OS integration, local engine lifecycle
- React + TypeScript: renderer UI
- Go local engine: DB connection, query execution, schema introspection, Redis exploration, storage, policy

## Rationale

Electron-only는 구현은 빠르지만 DB driver, credential, query policy, storage logic이 JavaScript/Electron boundary에 퍼질 위험이 크다.

Tauri + Rust는 더 가벼운 desktop app을 만들 수 있지만, 초기 제품에서 DB adapter, schema introspection, query streaming, Redis exploration, team/MCP 확장까지 안정적으로 구현하기에는 개발 비용이 높다.

Go local engine은 DB tooling에 적합하다.

- database driver 생태계가 충분하다.
- concurrency와 network IO 구현이 단순하다.
- 단일 바이너리 배포가 쉽다.
- 테스트 가능한 application/service 구조를 만들기 좋다.
- Electron이나 Tauri shell로부터 독립적으로 유지할 수 있다.

## Consequences

장점:

- 핵심 DB 로직을 UI와 분리할 수 있다.
- 나중에 desktop shell을 바꾸더라도 Go engine 재사용 가능성이 높다.
- DB adapter contract test를 구성하기 쉽다.
- account/team/MCP 기능을 application service 위에 확장할 수 있다.

단점:

- Electron과 Go process 사이의 lifecycle 관리가 필요하다.
- local API 인증과 process cleanup을 신중히 설계해야 한다.
- build/packaging pipeline이 단순 React app보다 복잡하다.

## Follow-up

- local engine process lifecycle을 Phase 0에서 먼저 검증한다.
- packaged app에서 Go binary 포함과 실행 path를 macOS/Windows 모두에서 확인한다.
- renderer가 local engine token을 직접 다루지 않도록 preload API를 설계한다.
