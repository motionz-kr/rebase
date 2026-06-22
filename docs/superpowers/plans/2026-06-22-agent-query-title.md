# Agent Query Title Auto-Save

## Goal

LLM Agent가 열린 상태에서 쿼리 저장, 히스토리 기록, 템플릿 저장 시 재사용하기 쉬운 제목을 자동으로 제안하거나 저장한다.

## Scope

- 렌더러 제목 생성 유틸 추가: LLM 응답 정리, 쿼리 리터럴 마스킹, 로컬 폴백 제목 생성.
- SQL/Redis/Mongo 저장 쿼리 이름 기본값을 자동 생성한다.
- SQL/Redis/Mongo 히스토리에 제목을 함께 저장하고 Query Library에서 표시한다.
- 템플릿 저장 다이얼로그 이름 기본값을 자동 생성한다.
- 기존 Query Library 모달 변경 범위 밖의 레이아웃은 건드리지 않는다.

## Validation

- renderer unit test: query title helper
- engine unit/contract test: query history name round-trip
- renderer lint/build, desktop build
- Electron Playwright flow: Query Library 진입 및 저장/히스토리 표시 경로 확인
