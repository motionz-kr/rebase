# Result Grid Column Resizing

## Goal

Make resizing a query result column feel continuous from its current rendered width, including the first drag, while preserving the existing minimum width and saved width behavior.

## Plan

1. Add a pure width calculation helper and tests for drag delta and minimum width.
2. Start each drag from the rendered header cell width, then apply the pointer delta through the helper.
3. Add a desktop E2E flow that runs a query against a throwaway SQLite database, resizes a result column, and checks the header and cells retain the new width.
4. Build the renderer and run the focused E2E flow; inspect the live interaction in the app.

## Verification

- Renderer unit tests for resize width calculation.
- Desktop Playwright E2E using an isolated SQLite fixture and isolated app profile.
