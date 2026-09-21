# Query diagnostics confidence

## Goal

Prevent the query editor from presenting incomplete or unavailable schema
metadata as a definitive table-not-found error while preserving useful
syntax, column, and runtime diagnostics.

## Scope

- Track schema completion readiness separately from the schema snapshot.
- Suppress name-resolution diagnostics while the active database metadata is
  loading or unavailable.
- Keep diagnostics advisory and distinguish them visually from runtime errors.
- Add renderer unit coverage for loading/unavailable schema state and preserve
  existing checks once metadata is ready.
- Add an Electron regression proving that the editor does not show a false
  table error before schema completion is ready.

## Implementation order

1. Add failing tests for the diagnostic readiness contract.
2. Implement the smallest renderer state/API change.
3. Update the editor wiring and visual severity/message mapping.
4. Run focused renderer tests and build.
5. Run the isolated Electron Playwright regression and inspect the live UI.

## Verification

- `pnpm --filter renderer test -- src/lib/sqlDiagnostics.test.ts`
- `pnpm --filter renderer build`
- `pnpm --filter desktop build`
- `pnpm --filter desktop exec playwright test e2e/query-diagnostics.spec.ts`

