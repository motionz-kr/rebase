# ADR 0003: Storage and Secret Management

## Status

Accepted

## Context

데이터베이스 데스크톱 툴은 DB password, token, private key, certificate 같은 민감 정보를 다룬다. 또한 saved SQL, query history, connection metadata, workspace metadata 같은 로컬 데이터를 저장해야 한다.

민감 정보와 일반 metadata를 같은 저장소에 평문으로 저장하면 보안 위험이 크다.

## Decision

SQLite에는 metadata만 저장하고, secret은 OS keychain에 저장한다.

SQLite 저장 대상:

- workspace
- connection profile metadata
- driver
- host
- port
- database
- username
- SSL option metadata
- `secretRef`
- saved query
- query history
- settings
- sync metadata

OS keychain 저장 대상:

- DB password
- access token
- private key
- certificate private key
- future cloud refresh token

## Rationale

SQLite는 local metadata 저장에 적합하고 migration 관리가 쉽다. 하지만 secret 저장소로 사용하기에는 적합하지 않다.

OS keychain은 사용자의 운영체제가 제공하는 credential storage를 활용할 수 있다.

이 분리는 future cloud/team 기능에도 유리하다. Connection profile은 sync 가능하지만, secret은 사용자의 device-local credential로 남길 수 있다.

## Consequences

장점:

- SQLite 파일 유출 시 secret 노출 위험을 줄인다.
- connection metadata와 secret lifecycle을 분리할 수 있다.
- cloud sync 시 secret 동기화 정책을 별도로 설계할 수 있다.

단점:

- keychain adapter가 필요하다.
- macOS와 Windows의 credential behavior 차이를 테스트해야 한다.
- secretRef와 keychain entry 정합성을 관리해야 한다.

## Rules

- SQLite에 secret value를 저장하지 않는다.
- log에 secret value를 출력하지 않는다.
- query history에 credential이 포함되지 않도록 한다.
- exported diagnostic bundle에 secret을 포함하지 않는다.
- keychain read 실패 시 사용자에게 재입력을 요구한다.

## Follow-up

- secret redaction utility를 domain/application boundary에 추가한다.
- keychain adapter contract test를 만든다.
- macOS와 Windows packaging smoke test에 keychain read/write를 포함한다.
