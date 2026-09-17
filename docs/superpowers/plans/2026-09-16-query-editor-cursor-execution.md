# Query editor cursor execution

## Goal

Make Cmd/Ctrl+Enter execute the SQL statement under the caret, or the selected
statements when a non-empty editor selection exists. Keep the toolbar Run action
as Run All so users can explicitly execute the whole script.

## Approach

1. Resolve the execution target from Monaco's caret and selection offsets using
   the existing statement splitter.
2. Pass the resolved SQL and source ranges through the existing single- and
   multi-statement execution paths without mutating the editor contents.
3. Add pure unit coverage for caret, selection, boundary, and empty-input cases.
4. Add an Electron E2E regression covering a failed multi-statement script and
   retrying only the failed block.

## Verification

- Renderer unit tests for the target resolver.
- Desktop Playwright query-context flow with an isolated temporary SQLite DB.
- Renderer and desktop TypeScript builds.
