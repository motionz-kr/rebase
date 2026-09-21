# Schema selection defaults and bulk toggle

## Goal

Make schema visibility opt-in for new connections and add a master checkbox so users can hide or show all schemas in one action.

## Scope

- Initialize a new connection with every schema hidden.
- Preserve explicit schema visibility choices and legacy table visibility preferences.
- Add a tri-state master checkbox to select or clear all schema visibility choices.
- Keep table-level visibility preferences independent from schema-level bulk actions.

## Verification

- Add renderer unit tests for new-connection defaults and bulk schema updates.
- Add/extend Playwright coverage for the master checkbox and individual schema selection.
- Run renderer tests/build and desktop build.
