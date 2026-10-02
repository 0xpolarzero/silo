# Changeset audit, 2026-10-02

Scope: changesets added after `f9421925`, audited through `2dcb7544` on
`codex/r14-website-docs`. This snapshot contains 412 new notes. Integration was
merged before the audit and after every folded correction.

All new notes use `"silo-ui": patch`; no front-matter correction was needed.
Summaries were reviewed against their commits and rewritten around the user
outcome. Internal terms such as worker, receipt, descriptor, and listener were
removed where they did not help explain that outcome. The audit follows the
[release policy](../../SiloUI-RELEASES.md).

## Duplicate corrections

| Commits | Evidence and retained note |
| --- | --- |
| `e0bfb0df`, `d9936652` | Both address retained desktop HTTP connections. HEAD uses the shared absolute deadline; `desktop-http-response-timeout.md` covers requests and uploads. |
| `91c8f4fb`, `1e7d0d60` | The same binary-launcher guard was added to `working-account.py`, with equivalent NUL spellings. Retain `preserve-decodable-binaries.md`. |
| `726467de`, `21198329` | Current and older computer-use setup paths repair the same save-completion behavior. Their combined user-facing note is `computer-use-durable-receipts.md`. |
| `ab9bc403`, `855d9083` | Production patches to `quit-request-confirmation.tsx` are identical. Retain `quit-cancel-focus.md`. |

## Commits without their own note

- `cbc493ed` changes Debian downloads for users with valid cached package lists.
  Added `debian-cached-update-downloads.md`; the existing five hermetic retention
  tests pass.
- `c217fd0b` follows the secret-assignment deletion fix and also prevents update
  preparation from blocking cleanup. Extended `secrets-deletion-save-order.md`
  to cover that additional outcome.
- `c7b6f9e4` follows the shutdown deadline fix and keeps failed Quit rollback from
  reopening sandbox starts during session shutdown. Extended
  `settings-session-shutdown-deadline.md`.
- `687e9b26` completes the restored-save callback repair already described by
  `fe-sandboxes-save-navigation.md`; adding another note would duplicate it.
- `78772939` limits notification-store cleanup to the token-removal failure
  already covered by `fix-personal-token-removal-retry.md`; it adds no separate
  user-facing behavior.
- Fixture, test, build preparation, packaging verification, and CI-only fixes
  need no application release note. This includes runtime staging/cache repair
  in build scripts, which does not change the running app.

## Verification

Changesets status parsed the pending notes. Each added note has a nonempty
summary and exactly one `silo-ui` patch or minor release entry; none uses major.
Normalized summary comparison found no exact duplicate text after consolidation.
The pending release remains `0.11.0`, including earlier feature notes outside
this audit's range. No version files or release artifacts were changed, and no
changesets were consumed. Markdown-only edits require no application build or
native test run; no app, VM, or production data was used.
