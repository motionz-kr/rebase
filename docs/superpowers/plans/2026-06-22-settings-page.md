# Settings Page

## Scope
- Replace the top-right settings popover with a full settings page opened from the existing settings icon.
- Use a two-column settings layout: menu on the left, selected settings panel on the right.
- First pass menu items:
  - General: version and update information.
  - Theme: light, dark, and system theme selection.

## Implementation Notes
- Keep the existing theme IPC and update IPC contracts.
- Keep the existing floating update progress card behavior.
- Avoid adding routing dependencies; the page can be an in-app overlay/screen controlled by `App`.

## Verification
- Renderer unit/build checks.
- Desktop E2E for opening settings, switching menus, checking version/update text, and changing theme.
