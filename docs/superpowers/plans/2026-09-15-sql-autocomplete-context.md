# SQL autocomplete context improvements

## Goal

Improve the existing SQL autocomplete so suggestions are based on the statement under the cursor, not unrelated earlier statements, and SQL text in strings/comments does not create false table or clause context.

## Scope

- Keep the existing custom autocomplete UI and schema-completion API.
- Isolate the current statement while respecting quoted strings/identifiers (including PostgreSQL dollar-quoted strings) and SQL comments when finding statement separators.
- Ignore string literals and comments when extracting table references and clauses.
- Preserve quoted identifiers and existing alias/dot completion behavior.
- Add focused unit tests and extend desktop E2E coverage for actual autocomplete interaction.

## Out of scope

- Fetching metadata for schemas/databases other than the active query-tab context.
- Replacing the completion parser with a full dialect-specific SQL parser.
- Persisted query history, schema diff, or other unrelated DataGrip features.

## Implementation and verification

1. Add failing pure tests for statement isolation and false references from strings/comments.
2. Implement a small SQL-aware scanner in the renderer completion module.
3. Verify unit tests, renderer build, and lint for touched files.
4. Extend the existing autocomplete E2E flow and run it against the packaged renderer/Electron path; skip cleanly when its MySQL fixture is unavailable.

## Risks

- SQL quoting/comment syntax varies by dialect. Handle common single/double/backtick/bracket quoting, PostgreSQL dollar-quoted strings, `--` and `/* */` comments, and MySQL `#` comments conservatively without changing the engine/API.
- The scanner only scopes autocomplete; it is not a complete SQL parser or validator.
