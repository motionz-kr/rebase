# Query Library Modal

## Scope
- Move `Saved`, `History`, and `Templates` out of the small focused sidebar panel.
- Add prominent entry buttons in the connected workspace header.
- Open the selected section in a large modal so queries/templates can be scanned and selected comfortably.

## Implementation Notes
- Reuse `SavedQueries`, `QueryHistory`, and `TemplatesPanel` behavior.
- Keep query selection semantics:
  - Saved/history loads the query into the active editor.
  - Templates open the existing template runner in the main workspace.
- Keep domain settings and new-template actions on the templates surface.

## Verification
- Renderer build/lint.
- Electron E2E for existing template flow updated to open the modal.
- Manual/HMR check in the running app.
