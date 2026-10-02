# Workflows micro-review: fixes

Scope: `.github/workflows/` correctness, supply-chain pinning, secret exposure,
and permission scopes. Fixes were made in `codex/fix-workflows` and folded
separately into `codex/integration`. The original read-only report remains in
the shared review worktree. These are internal publication-tooling changes;
no application changeset is required.

## WORKFLOWS-1: P2 — Unpinned privileged QEMU installer

- **Location:** `.github/workflows/guest-image.yml:60` at the initial review revision; the QEMU setup step.
- **Trigger:** The upstream `tonistiigi/binfmt:latest` tag changes before a cold publication run.
- **Consequence:** An action pinned to a commit still runs different upstream image bytes with host privileges in a job with package and release write permissions.
- **Fix:** `58eb72da`, folded. Set the action's supported `image` input to a reviewed SHA-256 digest and install only ARM64 emulation. Image version, source revision, upstream input/implementation links, and update policy are recorded in [the guest-image guide](../../SiloUI-GUEST-IMAGES.md).
- **Regression:** `test_workflow_pins.py` rejects an omitted or unpinned installer image. The new test failed before the fix; all three pinning tests pass afterward.

## WORKFLOWS-2: P2 — Failed lookups authorize an overwrite

- **Location:** `.github/workflows/guest-image.yml:71` at the initial review revision; the architecture existence guard, plus the release guard at line 56.
- **Trigger:** Retry a partial publication while an existing architecture's manifest lookup fails, then let the registry recover before the write.
- **Consequence:** The shell treats a failed lookup as absence and rebuilds/pushes over a published version. A synthetic HTTP 500 reproduction exited successfully before the fix.
- **Fix:** `562c2d37`, folded. A narrow HTTP preflight requires confirmed GitHub release absence and typed OCI manifest absence. It stops on authentication failures, transport errors, rate limits, server failures, malformed JSON, unclassified 404s, and redirects. It does not print credentials or HTTP bodies. The API choice and Docker inspector's error-classification gap are documented in the guest-image guide.
- **Regression:** `test_guest_publication.py` supplies HTTP fixtures at the standard-library transport seam. It covers both architectures, partial publication, first-publication absence, token acquisition, and failure cases. The existing shell's failure evidence and the new pre-implementation test failure are retained locally.
- **Limit:** The preflight does not reserve tags against writers outside the workflow's shared concurrency group. Authenticated hosted publication was not run.

## WORKFLOWS-3: P3 — A third guest-publication request cancels the pending second request

- **Location:** `.github/workflows/guest-image.yml:8`, workflow concurrency.
- **Trigger:** Three guest-image publication runs enter the shared group while the first is running or awaiting its environment approval.
- **Consequence:** The third replaces the pending second run despite `cancel-in-progress: false`; the canceled version requires a manual retry.
- **Fix:** `55a15541`, folded. Add GitHub's supported `queue: max` while preserving serialization and `cancel-in-progress: false`.
- **Evidence:** GitHub's [May 7, 2026 release announcement](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/) and [queue contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) document default pending-run replacement and the supported 100-run queue.
- **Regression:** The workflow policy test fails before the setting is added and passes afterward. No hosted queue was exercised.
- **Validation limitation:** Actionlint 1.7.12 rejects the supported `queue` key, tracked in [upstream issue 680](https://github.com/rhysd/actionlint/issues/680). Suppressing only `unexpected key "queue" for "concurrency" section` permits all remaining workflow checks to run; the policy test independently requires the supported value and cancellation combination.

## WORKFLOWS-4: P3 — Pending final publication is replaced

**P3**, `.github/workflows/publish-release.yml:13` before this fix. Three final
publication requests in the shared group canceled the pending second request,
even with cancellation of the running request disabled. Its draft remained
unpublished until the owner retried. The supported `queue: max` setting now
retains pending requests while preserving one publication at a time. The new
publication policy regression failed before the change; the release workflow
and publication fixture suites pass afterward. This uses the same supported
GitHub queue contract and documented Actionlint exception as WORKFLOWS-3.

## Verification

- `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_guest_publication test_workflow_pins test_release_workflow`: 22 tests pass after the queue fix.
- `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_guest_publication test_workflow_pins test_release_workflow test_release_publication test_publish_release test_linux_verification_release test_debian_release test_macos_release`: 66 tests pass on the integrated source, covering publication, Linux verification, Debian packaging, and macOS packaging fixtures.
- `npm --prefix app/SiloUI run test:release`: 98 pass, 12 intentional skips, no failures. Fixture commands use fake Git/GitHub adapters; no tag or publication was created.
- `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, and `CARGO_TARGET_DIR=/tmp/silo-codex-target cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` pass.
- `actionlint -shellcheck= -pyflakes= -ignore 'unexpected key "queue" for "concurrency" section' .github/workflows/*.yml`: Actionlint 1.7.12 validates every workflow with its documented queue-key false positive narrowly suppressed. External ShellCheck/Pyflakes integrations were not available in this run; Python syntax checks and `git diff --check` pass.
- An anonymous, read-only request to the existing public GHCR package confirmed a nonexistent tag returns HTTP 404 with `MANIFEST_UNKNOWN`. No private credentials were used.
- Failure evidence and release-test output remain under `/tmp/silo-codex-target/verification/workflows/`. No app, bundle, VM, authenticated release, or registry write was exercised.

The follow-up review checked permission declarations, credential-bearing steps,
artifact paths, source-ref handling, and required-job gates. Previously reported
defects remain excluded; no additional defect was confirmed in those checks.
