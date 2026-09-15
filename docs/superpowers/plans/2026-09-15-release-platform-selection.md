# Selective Platform Builds for New Releases

## Goal

Allow a newly published release to package only the requested platform while
preserving the current both-platform default and existing partial-rebuild flow.

## Design

- On a `push` that creates a release, read an optional `Release-Platform:`
  trailer from the pushed commit message.
- `mac` or `win` selects only that matrix job; `both` or no trailer keeps the
  current default of building both platforms.
- When `workflow_dispatch` creates a release, respect the existing `platform`
  input. Keep the `release_tag` rebuild path unchanged.
- Resolve the selected platform matrix in the prerequisite job and pass it to
  the build job as a JSON object containing `include`; GitHub Actions does not
  expose `matrix.*` in a job-level `if` expression and rejects a bare sequence
  as the matrix value.
- For existing-tag `workflow_dispatch` rebuilds, skip release-please and let
  the build depend on the resolved platform matrix plus the requested tag.
- Document the trailer convention and validate workflow syntax before merging.

## Validation

- Inspect the generated release merge message and matrix conditions.
- Run workflow YAML/actionlint validation when available.
- Run desktop and renderer build checks, then wait for PR CI and CodeQL.
- Verify the workflow run graph creates only a macOS build job for the
  `Release-Platform: mac` trailer.
- For v0.25.1, merge its Release PR with `Release-Platform: mac` and verify that
  only the macOS release job runs and publishes assets.

## Out of Scope

- Changing the default release behavior for releases without a platform trailer.
- Rebuilding or republishing the existing v0.25.0 release.
