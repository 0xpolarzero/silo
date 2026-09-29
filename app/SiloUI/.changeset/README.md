# Silo release notes

Run `npm run changeset` from `app/SiloUI` when completing a user-visible change.
Choose `silo-ui`, select patch or minor, and describe the change for someone
using the app. Commit the generated Markdown file with the implementation.
Agents may write the same Markdown format directly.

- **patch**: a fix or compatible refinement.
- **minor**: a new feature, or an incompatible change; explain migration steps.
- **major**: do not use. Silo stays below 1.0.0 until the owner decides on a
  stable release; `release:version` and `release:draft` refuse 1.0.0 or later
  unless `--allow-stable` is passed.

Internal refactors, tests, and documentation do not need a release note unless
they affect users. Several changesets are combined into one release; Changesets
chooses the largest requested bump, rather than adding each bump separately.

When ready, run `npm run release:status`, then `npm run release:version`.
Review and commit the generated files, push your branch, and run
`npm run release:draft`. After testing the draft, `npm run release:publish`
requests verified publication. No command publishes an npm package.

See [the release guide](../../../docs/SiloUI-RELEASES.md#release-a-new-version)
for prerequisites, review steps, signing approvals, and retry instructions.
