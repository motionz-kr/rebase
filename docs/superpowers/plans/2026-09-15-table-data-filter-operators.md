# Type-aware server-side table filters

## Goal

Make the existing server-side table data filter more expressive without rewriting arbitrary SQL result queries.

## Scope

- Add comparison operators for text, numeric/date, and boolean columns.
- Compile filters into driver-quoted SQL with literal escaping; NULL checks omit the value.
- Allow multiple server-side filter chips and preserve paging/sorting behavior.
- Add pure SQL builder/type-operator tests and isolated SQLite desktop E2E coverage.

## Out of scope

- Applying filters to arbitrary SQL result sets, where wrapping can change query semantics.
- Prepared-statement/transport changes, remote pagination totals, or changes to query-result local filtering.

## Verification

1. Add failing unit tests for SQL conditions, escaping, and type-aware operator lists.
2. Implement the filter model and UI.
3. Run renderer tests/build/lint and desktop TypeScript build.
4. Exercise text and numeric server filters against the disposable SQLite E2E table.
