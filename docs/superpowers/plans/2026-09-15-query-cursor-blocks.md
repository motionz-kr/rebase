# Cursor-Scoped SQL Execution and Statement Blocks

## Goal

Make the query editor behave like a statement-oriented SQL IDE: show the statement under the caret as a bordered code block, and make Cmd/Ctrl+Enter execute only the selected SQL or the statement at the caret. Keep the toolbar Run action as execute-all.

## Design

- Extract/test pure selection logic that resolves a non-empty selection first, otherwise the semicolon-delimited statement containing the cursor. Never fall back to executing the entire script when no statement is under the caret.
- Preserve source offsets so execution status decorations stay attached to the statement's original location, including when running only a later statement or a selection.
- Track caret/selection changes in Monaco and render a visible rectangular outline around the active statement's complete code area. Keep the existing success/running/error/skipped indicators independent from the active-block outline.
- Route Cmd/Ctrl+Enter through the new scoped-execution path; leave the toolbar Run button and its full-script sequential behavior unchanged.
- Add renderer unit tests for cursor boundaries, selected SQL, comments/empty positions, and source-offset mapping, plus a desktop Playwright regression for a multi-statement script.
- Update the smoke interaction in E2E to verify the block is visible and only the cursor statement executes.

## Validation

- TDD: add failing pure helper tests before implementation.
- Run the focused renderer unit tests, renderer lint/build, desktop build, and query-context Playwright E2E.
- Visually inspect the bordered statement block in the running Electron app.

## Out of scope

- Changing the toolbar Run action from execute-all.
- SQL dialect-specific client commands such as MySQL `DELIMITER` blocks; statement boundaries remain based on the existing quote/comment-aware semicolon parser.
