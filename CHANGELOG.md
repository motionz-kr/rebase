# Changelog

## [0.29.0](https://github.com/motionz-kr/rebase/compare/v0.28.1...v0.29.0) (2026-09-21)


### Features

* isolate schema actions by query tab ([9f64549](https://github.com/motionz-kr/rebase/commit/9f645493009cf6d05064fc7458583d267aa2fef3))

## [0.28.1](https://github.com/motionz-kr/rebase/compare/v0.28.0...v0.28.1) (2026-09-21)


### Bug Fixes

* preserve connection credentials on profile edits ([05ac00b](https://github.com/motionz-kr/rebase/commit/05ac00bfb4e8a005d8a6b78bbe72650cba10681e))
* preserve connection credentials on profile edits ([4f06343](https://github.com/motionz-kr/rebase/commit/4f063432ec35a40de9fc04312c446d23e2fc059a))

## [0.28.0](https://github.com/motionz-kr/rebase/compare/v0.27.1...v0.28.0) (2026-09-21)


### Features

* DataGrip 스타일 쿼리탭 세션 격리 ([#186](https://github.com/motionz-kr/rebase/issues/186)) ([67945a2](https://github.com/motionz-kr/rebase/commit/67945a2098f2cbdb6a2485f52d34693ef903b2c9))
* improve connection session lifecycle ([920b72c](https://github.com/motionz-kr/rebase/commit/920b72c3ef85658db98d9db99137e0f0050c2120))
* improve connection session lifecycle ([02c6d39](https://github.com/motionz-kr/rebase/commit/02c6d39ced25f94f3343d5497eccc151c7959928))
* 세션 관리 및 쿼리탭 복원 ([#187](https://github.com/motionz-kr/rebase/issues/187)) ([5bfdc1b](https://github.com/motionz-kr/rebase/commit/5bfdc1b588f2b7dba81093bf74c214429757ec04))


### Bug Fixes

* make schema diagnostics advisory ([8229bd1](https://github.com/motionz-kr/rebase/commit/8229bd153226ef0b04f281767aa2910b9426b595))
* make schema diagnostics advisory ([15c2fc6](https://github.com/motionz-kr/rebase/commit/15c2fc63768a18037ff10f442ffd8ee09b8c9ac6))

## [0.27.1](https://github.com/motionz-kr/rebase/compare/v0.27.0...v0.27.1) (2026-09-21)


### Bug Fixes

* prevent false positive SQL diagnostics and respect schema visibility ([5c327ce](https://github.com/motionz-kr/rebase/commit/5c327ceaeb89efa4dec2b4f8731d7c5e5bd2fc43))
* streamline query risk confirmation ([5d537e0](https://github.com/motionz-kr/rebase/commit/5d537e0837202c210c0c7671eaa86d567b040f83))
* streamline query risk confirmation ([b510b93](https://github.com/motionz-kr/rebase/commit/b510b93df31fe06b8179b5a9c5a6421a49e5bd3d))

## [0.27.0](https://github.com/motionz-kr/rebase/compare/v0.26.0...v0.27.0) (2026-09-17)


### Features

* govern MCP access and activity ([631050a](https://github.com/motionz-kr/rebase/commit/631050a3fe7e2c1242eb0c837d97dd41f8d9d505))
* govern MCP access and activity ([995c301](https://github.com/motionz-kr/rebase/commit/995c3017e9fded8250c2e869cc2bbb1c9664777f))


### Bug Fixes

* ignore system catalogs in SQL diagnostics ([6ec9bb4](https://github.com/motionz-kr/rebase/commit/6ec9bb4f9366471d93f2f9359d359eb249634b47))
* ignore system catalogs in SQL diagnostics ([1aec08c](https://github.com/motionz-kr/rebase/commit/1aec08cd4843bece4826f5083f85f3c68d9a1789))
* remove redundant diagnostics escape ([4d22122](https://github.com/motionz-kr/rebase/commit/4d22122c30f4d4f0e6a61935764fe9974f70d7b9))
* satisfy MCP panel lint checks ([34049c4](https://github.com/motionz-kr/rebase/commit/34049c487901c46938f9e4adae62ef58e970319d))

## [0.26.0](https://github.com/motionz-kr/rebase/compare/v0.25.1...v0.26.0) (2026-09-17)


### Features

* bundle DataGrip-inspired query workflow ([6b269e6](https://github.com/motionz-kr/rebase/commit/6b269e6e514844d354a6cf0cadbd9515b285c5ad))
* bundle DataGrip-inspired query workflow ([b9d7893](https://github.com/motionz-kr/rebase/commit/b9d789371011c2d249244076520633c0e71d38b4))


### Bug Fixes

* **release:** bypass release-please on tag rebuilds ([cf06789](https://github.com/motionz-kr/rebase/commit/cf067894f95fa0aecb98314e445b3ea272871cad))
* **release:** bypass release-please on tag rebuilds ([a95f22d](https://github.com/motionz-kr/rebase/commit/a95f22d51152e1b59548e1b2923693cf5c058683))
* **release:** bypass release-please on tag rebuilds ([#174](https://github.com/motionz-kr/rebase/issues/174)) ([cf06789](https://github.com/motionz-kr/rebase/commit/cf067894f95fa0aecb98314e445b3ea272871cad))
* **release:** wrap selected platforms in matrix object ([e73e4b1](https://github.com/motionz-kr/rebase/commit/e73e4b17886d6f7a4c71ff5f981e23d2534020a4))
* **release:** wrap selected platforms in matrix object ([107fc14](https://github.com/motionz-kr/rebase/commit/107fc14bc0c261ed79dcc120a85a3b2a19f58165))
* **release:** wrap selected platforms in matrix object ([#173](https://github.com/motionz-kr/rebase/issues/173)) ([e73e4b1](https://github.com/motionz-kr/rebase/commit/e73e4b17886d6f7a4c71ff5f981e23d2534020a4))

## [0.25.1](https://github.com/motionz-kr/rebase/compare/v0.25.0...v0.25.1) (2026-09-15)


### Bug Fixes

* **query:** run the statement at the cursor ([#168](https://github.com/motionz-kr/rebase/issues/168)) ([9f81434](https://github.com/motionz-kr/rebase/commit/9f81434fc1df18af05374041cd86d3ed2aad528b))
* **query:** scope Cmd+Enter to cursor statement ([1754983](https://github.com/motionz-kr/rebase/commit/175498385c14ec6061a3b296f37065ec45f3bb70))

## [0.25.0](https://github.com/motionz-kr/rebase/compare/v0.24.3...v0.25.0) (2026-09-15)


### Features

* **ui:** show SQL statement execution status ([#166](https://github.com/motionz-kr/rebase/issues/166)) ([c8d0a0f](https://github.com/motionz-kr/rebase/commit/c8d0a0f5c78525c7eba5e3516533e71ce5a7474c))

## [0.24.3](https://github.com/motionz-kr/rebase/compare/v0.24.2...v0.24.3) (2026-09-14)


### Bug Fixes

* **ui:** preserve selected database in query editor ([#164](https://github.com/motionz-kr/rebase/issues/164)) ([b19bde8](https://github.com/motionz-kr/rebase/commit/b19bde86a385c8cd81053fc65b383c5c549c6f98))

## [0.24.2](https://github.com/motionz-kr/rebase/compare/v0.24.1...v0.24.2) (2026-09-14)


### Bug Fixes

* **release:** harden macOS artifacts and test gating ([b1f8f95](https://github.com/motionz-kr/rebase/commit/b1f8f957b3c9bd4e769925774d3c3a0c3a8063b6))

## [0.24.1](https://github.com/motionz-kr/rebase/compare/v0.24.0...v0.24.1) (2026-06-22)


### Bug Fixes

* **release:** update feed 404와 mac notarization 안정화 ([#142](https://github.com/motionz-kr/rebase/issues/142)) ([6f088cd](https://github.com/motionz-kr/rebase/commit/6f088cd60fe748698583c1c631fb8c209e9e1435))

## [0.24.0](https://github.com/motionz-kr/rebase/compare/v0.23.0...v0.24.0) (2026-06-22)


### Features

* **agent:** Agent 설정과 쿼리 라이브러리 개선 ([#140](https://github.com/motionz-kr/rebase/issues/140)) ([7c0d8c9](https://github.com/motionz-kr/rebase/commit/7c0d8c95170c6c80ab0da69ef5f3021033f5a71a))

## [0.23.0](https://github.com/motionz-kr/rebase/compare/v0.22.0...v0.23.0) (2026-06-12)


### Features

* Agent MCP 클라이언트 HTTP 전송 (Streamable HTTP) ([#36](https://github.com/motionz-kr/rebase/issues/36)) ([#134](https://github.com/motionz-kr/rebase/issues/134)) ([6a94492](https://github.com/motionz-kr/rebase/commit/6a944929dd5242b4379f5cbc5febc4447262ca6e))

## [0.22.0](https://github.com/motionz-kr/rebase/compare/v0.21.0...v0.22.0) (2026-06-09)


### Features

* **renderer:** 스키마 트리 수동 새로고침 (DB별 + 연결 전체) ([#128](https://github.com/motionz-kr/rebase/issues/128)) ([ef55274](https://github.com/motionz-kr/rebase/commit/ef55274950e3d15af665745c44bed378f4cadf30))

## [0.21.0](https://github.com/motionz-kr/rebase/compare/v0.20.0...v0.21.0) (2026-06-08)


### Features

* Agent stdio MCP 클라이언트 — 외부 도구 ([#36](https://github.com/motionz-kr/rebase/issues/36)) ([#126](https://github.com/motionz-kr/rebase/issues/126)) ([f1c3a51](https://github.com/motionz-kr/rebase/commit/f1c3a519647ddbf61cb18d29d6c209ccae10f532))

## [0.20.0](https://github.com/motionz-kr/rebase/compare/v0.19.0...v0.20.0) (2026-06-08)


### Features

* 도메인 이해 기반 DB Assistant ([#103](https://github.com/motionz-kr/rebase/issues/103)) ([#124](https://github.com/motionz-kr/rebase/issues/124)) ([cf54f5b](https://github.com/motionz-kr/rebase/commit/cf54f5b090ad974e19b8ef387c1cd234e949efb3))

## [0.19.0](https://github.com/motionz-kr/rebase/compare/v0.18.1...v0.19.0) (2026-06-07)


### Features

* 쿼리 결과 → 업무 문장 변환 (Result Narration) ([#104](https://github.com/motionz-kr/rebase/issues/104)) ([#122](https://github.com/motionz-kr/rebase/issues/122)) ([346ef52](https://github.com/motionz-kr/rebase/commit/346ef524c069a376e68f53a89054fa064c39f984))

## [0.18.1](https://github.com/motionz-kr/rebase/compare/v0.18.0...v0.18.1) (2026-06-07)


### Bug Fixes

* **renderer:** 다이얼로그·템플릿 UI 테마 토큰 정렬 ([#120](https://github.com/motionz-kr/rebase/issues/120)) ([d3aece6](https://github.com/motionz-kr/rebase/commit/d3aece61ab489909722d377b01ef7de23aad8659))

## [0.18.0](https://github.com/motionz-kr/rebase/compare/v0.17.1...v0.18.0) (2026-06-07)


### Features

* 반복 DB 업무 자동화 템플릿 ([#105](https://github.com/motionz-kr/rebase/issues/105)) ([#118](https://github.com/motionz-kr/rebase/issues/118)) ([7f2f6c7](https://github.com/motionz-kr/rebase/commit/7f2f6c7a405d8eabafd33a4f5e8760795bf315f0))

## [0.17.1](https://github.com/motionz-kr/rebase/compare/v0.17.0...v0.17.1) (2026-06-06)


### Bug Fixes

* **desktop:** Windows 아이콘 256x256 포함 ([#115](https://github.com/motionz-kr/rebase/issues/115)) ([eda23d7](https://github.com/motionz-kr/rebase/commit/eda23d796e85b958247d9022407bd27e7807d513))

## [0.17.0](https://github.com/motionz-kr/rebase/compare/v0.16.0...v0.17.0) (2026-06-06)


### Features

* 앱 로고·아이콘 + 라이트/다크/시스템 테마 ([#112](https://github.com/motionz-kr/rebase/issues/112)) ([1d96a44](https://github.com/motionz-kr/rebase/commit/1d96a444afb74b60ec5e56ab9ca45b018f7b8727))
* 운영 DB 안전 실행 모드 ([#102](https://github.com/motionz-kr/rebase/issues/102)) ([#114](https://github.com/motionz-kr/rebase/issues/114)) ([58084ca](https://github.com/motionz-kr/rebase/commit/58084cadb2d7edd0466f7db75093464c420cf512))

## [0.16.0](https://github.com/motionz-kr/rebase/compare/v0.15.0...v0.16.0) (2026-06-06)


### Features

* Redis·MongoDB에 내보내기·저장쿼리/히스토리·AI 어시스턴트 추가 ([#110](https://github.com/motionz-kr/rebase/issues/110)) ([2aee90e](https://github.com/motionz-kr/rebase/commit/2aee90e6c34637edf175d8267f823232677ada1d))

## [0.15.0](https://github.com/motionz-kr/rebase/compare/v0.14.1...v0.15.0) (2026-06-06)


### Features

* MongoDB 연결 지원 (engine expansion [#34](https://github.com/motionz-kr/rebase/issues/34)) ([#108](https://github.com/motionz-kr/rebase/issues/108)) ([0ccf08b](https://github.com/motionz-kr/rebase/commit/0ccf08bea862fa1df5056b7b36312c83ba7e458b))

## [0.14.1](https://github.com/motionz-kr/rebase/compare/v0.14.0...v0.14.1) (2026-06-06)


### Bug Fixes

* **renderer:** 테이블 DDL 다이얼로그 라벨↔입력창 정렬 ([#100](https://github.com/motionz-kr/rebase/issues/100)) ([e11e1cc](https://github.com/motionz-kr/rebase/commit/e11e1cc4b85607996dee655f1fe36f46bdde7d08))

## [0.14.0](https://github.com/motionz-kr/rebase/compare/v0.13.0...v0.14.0) (2026-06-05)


### Features

* SQL Server 연결 지원 (engine expansion [#34](https://github.com/motionz-kr/rebase/issues/34)) ([#98](https://github.com/motionz-kr/rebase/issues/98)) ([7f93f3d](https://github.com/motionz-kr/rebase/commit/7f93f3d13b88ab631b255be8e191ab25159bd1e7))

## [0.13.0](https://github.com/motionz-kr/rebase/compare/v0.12.1...v0.13.0) (2026-06-05)


### Features

* SQLite 연결 지원 (engine expansion [#34](https://github.com/motionz-kr/rebase/issues/34)) ([#96](https://github.com/motionz-kr/rebase/issues/96)) ([bcb5001](https://github.com/motionz-kr/rebase/commit/bcb500183e1385fb8298712923906bc9ac6ddd71))

## [0.12.1](https://github.com/motionz-kr/rebase/compare/v0.12.0...v0.12.1) (2026-06-05)


### Bug Fixes

* **update:** desktop updateEvents 테스트를 새 progress 형태에 맞춤 ([#94](https://github.com/motionz-kr/rebase/issues/94)) ([913b6e9](https://github.com/motionz-kr/rebase/commit/913b6e94a62b6763bd9291cbadba80a48d7fbc70))

## [0.12.0](https://github.com/motionz-kr/rebase/compare/v0.11.0...v0.12.0) (2026-06-05)


### Features

* **update:** 시작 시 자동 업데이트 다운로드 (진행바·용량·ETA) ([#92](https://github.com/motionz-kr/rebase/issues/92)) ([adb5335](https://github.com/motionz-kr/rebase/commit/adb53356b98ec0e9ffc5e8b133e02b6c0d791875))

## [0.11.0](https://github.com/motionz-kr/rebase/compare/v0.10.0...v0.11.0) (2026-06-05)


### Features

* **agent:** subscription OAuth login — Claude + Codex/ChatGPT (no API key, no CLI) ([#90](https://github.com/motionz-kr/rebase/issues/90)) ([7fb7378](https://github.com/motionz-kr/rebase/commit/7fb7378c91421084382a461fda205a5154a75582))
* **ui:** split the connection modal into tabs ([#89](https://github.com/motionz-kr/rebase/issues/89)) ([7f7f552](https://github.com/motionz-kr/rebase/commit/7f7f55262f4d0bcd80f9715906e69baa50e3ec62))

## [0.10.0](https://github.com/motionz-kr/rebase/compare/v0.9.1...v0.10.0) (2026-06-05)


### Features

* **ui:** connection create/edit form as a resizable modal ([#87](https://github.com/motionz-kr/rebase/issues/87)) ([dd24260](https://github.com/motionz-kr/rebase/commit/dd24260eee44e9ff1d0e3909cf8ee7101089c542))

## [0.9.1](https://github.com/motionz-kr/rebase/compare/v0.9.0...v0.9.1) (2026-06-05)


### Bug Fixes

* **ci:** don't set empty CSC_LINK on Windows release build ([#85](https://github.com/motionz-kr/rebase/issues/85)) ([7cd3afa](https://github.com/motionz-kr/rebase/commit/7cd3afabb555f47b8257264213e5df83e7df2944))

## [0.9.0](https://github.com/motionz-kr/rebase/compare/v0.8.0...v0.9.0) (2026-06-05)


### Features

* **update:** sign + notarize macOS build, enable in-app self-update ([#83](https://github.com/motionz-kr/rebase/issues/83)) ([f1dc7ae](https://github.com/motionz-kr/rebase/commit/f1dc7ae5612ee5a4c35185aef152e1731827ec51))

## [0.8.0](https://github.com/motionz-kr/rebase/compare/v0.7.1...v0.8.0) (2026-06-05)


### Features

* **ui:** table show/hide in connection Edit dialog; fix macOS self-update ([#80](https://github.com/motionz-kr/rebase/issues/80)) ([a870cc3](https://github.com/motionz-kr/rebase/commit/a870cc3b45ea5e9dbf8e10294c47d5289186fff1))

## [0.7.1](https://github.com/motionz-kr/rebase/compare/v0.7.0...v0.7.1) (2026-06-04)


### Bug Fixes

* **build:** add app description/author metadata ([#78](https://github.com/motionz-kr/rebase/issues/78)) ([b12320b](https://github.com/motionz-kr/rebase/commit/b12320b4e03fc5282b10b6e5797349c636aa42b7))

## [0.7.0](https://github.com/motionz-kr/rebase/compare/v0.6.0...v0.7.0) (2026-06-04)


### Features

* **update:** attempt in-app self-update on macOS (ad-hoc) with page fallback ([#76](https://github.com/motionz-kr/rebase/issues/76)) ([17d858a](https://github.com/motionz-kr/rebase/commit/17d858a21b20fd253e95f888333c9c9f7e7d2c0e))

## [0.6.0](https://github.com/motionz-kr/rebase/compare/v0.5.3...v0.6.0) (2026-06-04)


### Features

* **ui:** resizable sidebar, table hide/show, column resize/reorder ([#74](https://github.com/motionz-kr/rebase/issues/74)) ([9dd55d0](https://github.com/motionz-kr/rebase/commit/9dd55d0784a8a187ef01d53cb6873852fd129a5c))

## [0.5.3](https://github.com/motionz-kr/rebase/compare/v0.5.2...v0.5.3) (2026-06-04)


### Bug Fixes

* result-grid/editor bugs (column case, LIMIT re-run, read-only) ([#71](https://github.com/motionz-kr/rebase/issues/71)) ([5e925de](https://github.com/motionz-kr/rebase/commit/5e925de7cc359e0c34a15164180e31d67ca238cf))
