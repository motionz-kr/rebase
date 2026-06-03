# Changelog

## [0.4.0](https://github.com/motionz-kr/rebase/compare/v0.3.0...v0.4.0) (2026-06-03)


### Features

* **mcp:** expose Rebase to external AI clients ([#37](https://github.com/motionz-kr/rebase/issues/37)) ([c4a5f78](https://github.com/motionz-kr/rebase/commit/c4a5f7836687fd31d547efbf3d23a3cb1aef0748))

## [0.3.0](https://github.com/motionz-kr/rebase/compare/v0.2.0...v0.3.0) (2026-06-03)


### Features

* **agent:** Agent Mode P1 — provider port, tools, loop, chat panel (stub-verified) ([1d0be49](https://github.com/motionz-kr/rebase/commit/1d0be4957d4b4f134fdcd2c2e3d19a7d5f9273a7))
* **agent:** claude CLI login status + Log-in action ([3005282](https://github.com/motionz-kr/rebase/commit/30052821ea2ebf93cade307bd6a6d3c0ee5a6bc4))
* **agent:** close milestone gaps — API key in keychain ([#10](https://github.com/motionz-kr/rebase/issues/10)) + secret redaction ([#14](https://github.com/motionz-kr/rebase/issues/14)) ([3b830a0](https://github.com/motionz-kr/rebase/commit/3b830a0680f7b1faad97a8a0d03ac9e69fb0295a))
* **agent:** codex CLI provider — login reuse via MCP (like claude) ([e1bbc00](https://github.com/motionz-kr/rebase/commit/e1bbc0044ac87b98b6b9f31f4f3901bff01fe1b7))
* **agent:** P3 safety — write proposals, approval gate, policy ([7562115](https://github.com/motionz-kr/rebase/commit/7562115f1376b2a0688c1eb8d1c248a6f2e3b69f))
* **agent:** wire agent pipeline end-to-end (transport + IPC + chat panel) ([95a2c16](https://github.com/motionz-kr/rebase/commit/95a2c1683816d7e795160f1ed08288cfd5615a27))
* **engine,desktop:** expose Redis write ops over HTTP + IPC ([2b43a6d](https://github.com/motionz-kr/rebase/commit/2b43a6dad07a4b1a4dd2502a3662d4188357835c))
* **fk:** expose ListForeignKeys endpoint + IPC ([20d967b](https://github.com/motionz-kr/rebase/commit/20d967bea7ff7ed4e751f6de7a8090ba720a6ae4))
* in-app auto-update (electron-updater) ([d9542e2](https://github.com/motionz-kr/rebase/commit/d9542e23b1966f88ea03c8915cc1e5ca33591faa))
* **index:** index manager UI — list, create, drop indexes ([d0e0e63](https://github.com/motionz-kr/rebase/commit/d0e0e6316425af9b9d6d06b2f8a1afb86172d881))
* **ipc:** add executeBatch bridge to engine batch endpoint ([cb8c46f](https://github.com/motionz-kr/rebase/commit/cb8c46f6ff523d1d7d2769b109cb5067edcab049))
* **ipc:** listViews + getViewDDL bridges ([7d737bf](https://github.com/motionz-kr/rebase/commit/7d737bfc6cb1e9b0a7e00eab6738fba7b2cc66f9))
* **profiles:** expose UpdateProfile via PUT /profiles + IPC ([816c3a8](https://github.com/motionz-kr/rebase/commit/816c3a837b913bb05dbc38df301743e538fe9d98))
* **query:** editable result for single-table SELECT * ([3166d3d](https://github.com/motionz-kr/rebase/commit/3166d3d3e05b68c2a5ca64af779e22aa03a05dab))
* Redis command console ([#7](https://github.com/motionz-kr/rebase/issues/7)) ([7791e31](https://github.com/motionz-kr/rebase/commit/7791e314d8cf76f8a7d63d528ebcd9d1d8a397d1))
* **schema:** one-click 'recent 500 rows' from table context menu ([878d39a](https://github.com/motionz-kr/rebase/commit/878d39a3f0d45fb2e102d7a15030fb6fc6d44ed6))
* **update:** IPC wiring (main + preload + types) ([a73bbad](https://github.com/motionz-kr/rebase/commit/a73bbadbd053f881d4092164780bbcd00b8c31c8))
* **update:** pure electron-updater event mapping (TDD) ([d1da28e](https://github.com/motionz-kr/rebase/commit/d1da28e0eb0994c5eac532c906fde03245f64916))
* **update:** pure platform/signing policy gate (TDD) ([80d6c6c](https://github.com/motionz-kr/rebase/commit/80d6c6c0862c2e046cbce1b1087f9ed6c635ad19))
* **update:** UpdateService wrapping electron-updater ([abc48b0](https://github.com/motionz-kr/rebase/commit/abc48b0f16d0f9a7b86099ae98acf191cfc04314))
* **window:** hidden title bar matching the theme, app-named, draggable ([eeb4932](https://github.com/motionz-kr/rebase/commit/eeb49328842f9e2a969c012da650c43052cf0d73))


### Bug Fixes

* **grid:** add-row inputs render flush below the table, styled like rows ([2fd5c43](https://github.com/motionz-kr/rebase/commit/2fd5c43a78b3158db0e56001a99810f8f5dfcee7))
* **release:** upload installers to the existing release (releaseType=release) ([65029d7](https://github.com/motionz-kr/rebase/commit/65029d747677acb37e9f05c5b98aeb717532e1a5))
* **update:** named import of electron-updater autoUpdater ([224455a](https://github.com/motionz-kr/rebase/commit/224455a3d694232cff02ff9b640254809464811e))

## [0.2.0](https://github.com/motionz-kr/rebase/compare/v0.1.0...v0.2.0) (2026-06-03)


### Features

* **agent:** Agent Mode P1 — provider port, tools, loop, chat panel (stub-verified) ([1d0be49](https://github.com/motionz-kr/rebase/commit/1d0be4957d4b4f134fdcd2c2e3d19a7d5f9273a7))
* **agent:** claude CLI login status + Log-in action ([3005282](https://github.com/motionz-kr/rebase/commit/30052821ea2ebf93cade307bd6a6d3c0ee5a6bc4))
* **agent:** close milestone gaps — API key in keychain ([#10](https://github.com/motionz-kr/rebase/issues/10)) + secret redaction ([#14](https://github.com/motionz-kr/rebase/issues/14)) ([3b830a0](https://github.com/motionz-kr/rebase/commit/3b830a0680f7b1faad97a8a0d03ac9e69fb0295a))
* **agent:** codex CLI provider — login reuse via MCP (like claude) ([e1bbc00](https://github.com/motionz-kr/rebase/commit/e1bbc0044ac87b98b6b9f31f4f3901bff01fe1b7))
* **agent:** P3 safety — write proposals, approval gate, policy ([7562115](https://github.com/motionz-kr/rebase/commit/7562115f1376b2a0688c1eb8d1c248a6f2e3b69f))
* **agent:** wire agent pipeline end-to-end (transport + IPC + chat panel) ([95a2c16](https://github.com/motionz-kr/rebase/commit/95a2c1683816d7e795160f1ed08288cfd5615a27))
* **engine,desktop:** expose Redis write ops over HTTP + IPC ([2b43a6d](https://github.com/motionz-kr/rebase/commit/2b43a6dad07a4b1a4dd2502a3662d4188357835c))
* **fk:** expose ListForeignKeys endpoint + IPC ([20d967b](https://github.com/motionz-kr/rebase/commit/20d967bea7ff7ed4e751f6de7a8090ba720a6ae4))
* in-app auto-update (electron-updater) ([d9542e2](https://github.com/motionz-kr/rebase/commit/d9542e23b1966f88ea03c8915cc1e5ca33591faa))
* **index:** index manager UI — list, create, drop indexes ([d0e0e63](https://github.com/motionz-kr/rebase/commit/d0e0e6316425af9b9d6d06b2f8a1afb86172d881))
* **ipc:** add executeBatch bridge to engine batch endpoint ([cb8c46f](https://github.com/motionz-kr/rebase/commit/cb8c46f6ff523d1d7d2769b109cb5067edcab049))
* **ipc:** listViews + getViewDDL bridges ([7d737bf](https://github.com/motionz-kr/rebase/commit/7d737bfc6cb1e9b0a7e00eab6738fba7b2cc66f9))
* **profiles:** expose UpdateProfile via PUT /profiles + IPC ([816c3a8](https://github.com/motionz-kr/rebase/commit/816c3a837b913bb05dbc38df301743e538fe9d98))
* **query:** editable result for single-table SELECT * ([3166d3d](https://github.com/motionz-kr/rebase/commit/3166d3d3e05b68c2a5ca64af779e22aa03a05dab))
* Redis command console ([#7](https://github.com/motionz-kr/rebase/issues/7)) ([7791e31](https://github.com/motionz-kr/rebase/commit/7791e314d8cf76f8a7d63d528ebcd9d1d8a397d1))
* **schema:** one-click 'recent 500 rows' from table context menu ([878d39a](https://github.com/motionz-kr/rebase/commit/878d39a3f0d45fb2e102d7a15030fb6fc6d44ed6))
* **update:** IPC wiring (main + preload + types) ([a73bbad](https://github.com/motionz-kr/rebase/commit/a73bbadbd053f881d4092164780bbcd00b8c31c8))
* **update:** pure electron-updater event mapping (TDD) ([d1da28e](https://github.com/motionz-kr/rebase/commit/d1da28e0eb0994c5eac532c906fde03245f64916))
* **update:** pure platform/signing policy gate (TDD) ([80d6c6c](https://github.com/motionz-kr/rebase/commit/80d6c6c0862c2e046cbce1b1087f9ed6c635ad19))
* **update:** UpdateService wrapping electron-updater ([abc48b0](https://github.com/motionz-kr/rebase/commit/abc48b0f16d0f9a7b86099ae98acf191cfc04314))
* **window:** hidden title bar matching the theme, app-named, draggable ([eeb4932](https://github.com/motionz-kr/rebase/commit/eeb49328842f9e2a969c012da650c43052cf0d73))


### Bug Fixes

* **grid:** add-row inputs render flush below the table, styled like rows ([2fd5c43](https://github.com/motionz-kr/rebase/commit/2fd5c43a78b3158db0e56001a99810f8f5dfcee7))
* **update:** named import of electron-updater autoUpdater ([224455a](https://github.com/motionz-kr/rebase/commit/224455a3d694232cff02ff9b640254809464811e))
