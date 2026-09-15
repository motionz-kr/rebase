# Release Build Target Selection

## Goal

Allow maintainers to rebuild one platform for an already published release, while keeping automatic Release Please releases building both platforms in parallel. Remove the Windows package-only pass that duplicates the actual publish packaging.

## Design

- Keep Release Please and publishing in the same workflow so releases created with `GITHUB_TOKEN` continue to build without relying on a second workflow trigger.
- Extend `workflow_dispatch` with an optional existing release tag and a platform selector (`both`, `mac`, or `win`). With no tag, manual dispatch remains a Release Please check and does not run packaging.
- For a manual platform rebuild, validate the tag format and confirm the GitHub Release exists before checking out code or starting expensive build steps. Check out the exact tag.
- Keep the automatic release matrix unchanged: a newly created release builds macOS and Windows concurrently.
- Run the package-only preflight and packaged-app smoke test on macOS only. Windows has no corresponding smoke test, so its publish step can build the release artifacts once instead of building them twice.
- Preserve macOS DMG best-effort behavior, required ZIP publication, notarization, updater metadata, and the order that leaves `latest-mac.yml` pointing to the ZIP.
- Document the manual partial-rebuild procedure and its limitations.

## Validation

- Validate workflow YAML and expressions with an available GitHub Actions linter/parser.
- Inspect the resulting workflow logic for automatic both-platform releases, manual single-platform selection, missing manual tag, invalid tag, and missing release cases.
- Run repository CI checks relevant to the documentation/workflow-only change where practical.

## Out of scope

- Combining macOS signing/notarization across DMG and ZIP builds. This needs a separate artifact-flow experiment so it does not weaken packaged-app smoke testing or updater metadata correctness.
