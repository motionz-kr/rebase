# Product Brief

## 목적

이 프로젝트는 macOS와 Windows에서 동작하는 가벼운 데이터베이스 데스크톱 툴을 만든다.

현재 사용자는 DataGrip, DBeaver 같은 범용 DB 툴을 통해 RDS, local MySQL, PostgreSQL, Redis에 접속한다. 이 프로젝트의 목표는 기존 대형 DB IDE의 모든 기능을 복제하는 것이 아니라, 자주 쓰는 연결, 탐색, 쿼리 실행, 결과 확인, SQL 관리 흐름을 더 가볍고 이해하기 쉬운 제품으로 제공하는 것이다.

## 제품 방향

초기 제품은 local-first desktop app이다.

- 사용자는 앱을 설치하고 로컬에서 DB에 접속한다.
- DB credential은 사용자의 OS keychain에 저장한다.
- query history, saved SQL, connection metadata는 로컬 SQLite에 저장한다.
- 핵심 기능이 안정화된 뒤 account, team workspace, shared SQL, MCP settings를 확장한다.

장기적으로는 개인용 DB client에서 팀 단위 SQL knowledge base와 MCP 연결 관리 도구로 확장한다.

MVP의 managed database 접속 범위는 사용자의 네트워크에서 DB endpoint에 접근 가능하고 TLS 설정으로 연결할 수 있는 환경을 기준으로 한다. Bastion host나 private subnet 때문에 SSH tunnel 없이는 접근할 수 없는 환경은 post-MVP 범위로 둔다.

## 초기 지원 범위

초기 지원 DB는 아래 3개다.

- MySQL
- PostgreSQL
- Redis

초기 MVP는 아래 사용자 흐름을 지원한다.

- connection profile 생성, 수정, 삭제
- connection test
- MySQL/PostgreSQL/Redis TLS 설정
- RDS, Cloud SQL, Azure Database 같은 managed database의 TLS 기반 접속
- MySQL/PostgreSQL schema, table, column 탐색
- SQL editor에서 query 실행
- query result grid 표시
- query timeout 및 cancellation
- query history 저장
- saved SQL 저장
- Redis key scan
- Redis key type, value, TTL 조회

## 장기 지원 범위

MVP 이후 아래 기능을 단계적으로 추가한다.

- account login
- team workspace
- shared SQL
- query permission
- audit log
- cloud sync
- MCP connection settings
- MCP read-only mode
- MCP destructive query policy
- SSH tunnel
- advanced certificate profile
- export CSV/JSON
- table data editing
- explain plan

## 명시적으로 초기 범위에서 제외하는 것

아래 기능은 제품 핵심 흐름이 검증되기 전까지 만들지 않는다.

- 대규모 DB migration tool
- ERD auto layout
- SQL 공동 편집
- AI query assistant
- billing
- plugin marketplace
- 모든 DB vendor 동시 지원
- DataGrip/DBeaver 수준의 전체 IDE 기능

## 성공 기준

초기 성공 기준은 아래와 같다.

- macOS와 Windows에서 앱이 안정적으로 실행된다.
- MySQL, PostgreSQL, Redis connection test가 가능하다.
- MySQL/PostgreSQL/Redis TLS connection test가 가능하다.
- MySQL/PostgreSQL query 실행과 result grid 확인이 가능하다.
- Redis key 탐색과 value 조회가 가능하다.
- secret이 SQLite나 일반 설정 파일에 평문 저장되지 않는다.
- 핵심 로직이 React/Electron에 흩어지지 않고 Go local engine에 모여 있다.
- 새로운 DB adapter를 추가할 때 application layer를 크게 수정하지 않는다.
