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

## WORKFLOWS-5: P2 — Existing multi-architecture image tag can be overwritten

The preflight checked `-arm64` and `-amd64` tags but omitted the unsuffixed
multi-architecture tag that the workflow also publishes. If that tag exists
while the architecture tags and GitHub release are absent, publication would
replace its manifest. A transport fixture reproduced the missing rejection
before the fix. The guard now requires confirmed absence of all three tags;
fixtures cover the existing index and failed index lookups as well as successful
first publication. This retains WORKFLOWS-2's external-writer race limitation.

## WORKFLOWS-6: P2 — Failed guest archive writes wait on the producer indefinitely

When compression or archive output fails, the pipeline destroys its streams but
the exporter still waits for `docker save` to exit. A client waiting on its daemon
can keep the build running until the workflow timeout. A synthetic ENOSPC output
stream and a real disposable producer reproduced the hang: the test exceeded its
eight-second deadline. The pipeline now terminates its own producer on failure,
then waits for both results before removing staging files. The regression checks
prompt failure, the original output error, unchanged prior artifacts, and no
remaining staging directory, and that the fixture producer has exited. This uses
Node's supported [stream pipeline](https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-callback)
and [child-process signal](https://nodejs.org/api/child_process.html#subprocesskillsignal)
APIs. SIGTERM targets only the directly spawned client; daemon state is not
asserted. No Docker daemon or real images were used. Twelve ordinary guest-image
tests pass; eleven live-image tests are intentionally skipped. Lint, typecheck,
Rust formatting, and whitespace checks pass.

## WORKFLOWS-7: P2 — Final publication accepts a non-executable macOS updater

`verify-release-metadata.py` checked the Mach-O header but ignored the archive
entry's executable mode. An ARM64 archive with the correct production identifier,
version, target, and binary header passed with mode `0644` or `0654`. The macOS
updater's [archive installer](../../../app/SiloUI/src-tauri/vendor/tauri-plugin-updater/src/atomic_install.rs) extracts entries with their modes, so the
installed application's owner cannot execute those files. The final publication
gate now requires the executable entry's owner-execute bit. Regressions rejected
both broken modes only after the fix and still accept `0755`; metadata and final
publication fixture suites pass. These are archive fixtures, not installed-app
or live updater tests.

## WORKFLOWS-8: P2 — Runtime cache producer emits links rejected by its consumer

The public-cache packer accepted ordinary files sharing an inode, then Python's
default tar writer encoded the second pathname as a hardlink. The importer
correctly rejects every link entry, so a cold platform job could successfully
produce an archive that both downstream jobs refused to import. A fixture with
two hardlinked, allowlisted public license files reproduced this round-trip
failure. The producer now uses Python's supported
[`dereference` option](https://docs.python.org/3.12/library/tarfile.html#tarfile.TarFile.dereference)
to emit file bytes at both paths. Existing producer symlink checks and consumer
link rejection remain. The new round-trip regression verifies both contents
and independent destination inodes; unsafe-path, link, checksum, and workflow
boundary tests still pass. No native resources were built or downloaded.

## WORKFLOWS-9: P3 — Empty unreviewed draft assets bypass exact membership

Final publication excluded zero-byte assets before comparing the draft against
its expected asset set. A draft containing an extra empty placeholder therefore
passed all checks and published that unreviewed attachment, although draft
creation rejects every extra file. The failing fixture confirmed publication
was allowed. The final gate now compares every attachment name and separately
requires every attachment to be nonempty. Regressions reject both an extra empty
attachment and an empty required package before download or publication. The
complete reviewed draft still publishes in the fixture.

## WORKFLOWS-10: P2 — Malformed optional feed fields disable update checks

The final gate checked feed versions and platform mappings but accepted an
invalid `pub_date` or non-string `notes`. The pinned updater's
[`RemoteRelease` deserializer](../../../app/SiloUI/src-tauri/vendor/tauri-plugin-updater/src/updater.rs)
requires optional string notes and an RFC3339 timestamp; invalid fields reject
the whole feed before the release is offered. Five failing subcases retained
matching draft checksums and still reached publication. The final gate now
checks those optional fields, including calendar validity through Python's
standard datetime parser. Valid generated timestamps, UTC `Z`, numeric offsets,
and null optional fields remain accepted. Publication fixtures cover both
rejection and acceptance; no live update feed was contacted.

## Initial verification

- `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_guest_publication test_workflow_pins test_release_workflow`: 22 tests pass after the queue fix.
- `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_guest_publication test_workflow_pins test_release_workflow test_release_publication test_publish_release test_linux_verification_release test_debian_release test_macos_release`: 66 tests pass on the integrated source, covering publication, Linux verification, Debian packaging, and macOS packaging fixtures.
- `npm --prefix app/SiloUI run test:release`: 98 pass, 12 intentional skips, no failures. Fixture commands use fake Git/GitHub adapters; no tag or publication was created.
- `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, and `CARGO_TARGET_DIR=/tmp/silo-codex-target cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` pass.
- `actionlint -shellcheck= -pyflakes= -ignore 'unexpected key "queue" for "concurrency" section' .github/workflows/*.yml`: Actionlint 1.7.12 validates every workflow with its documented queue-key false positive narrowly suppressed. External ShellCheck/Pyflakes integrations were not available in this run; Python syntax checks and `git diff --check` pass.
- An anonymous, read-only request to the existing public GHCR package confirmed a nonexistent tag returns HTTP 404 with `MANIFEST_UNKNOWN`. No private credentials were used.
- Failure evidence and release-test output remain under `/tmp/silo-codex-target/verification/workflows/`. No app, bundle, VM, authenticated release, or registry write was exercised.

## Continued fix loop, 2026-10-02

Each defect had a failing regression before its fix, an atomic commit, and a
separate successful fold into integration. All edits stayed in the dedicated
`codex-fix-workflows` worktree. The continuation found these seven defects:

| Finding | Fixed and folded commit |
| --- | --- |
| WORKFLOWS-4: final publication queue | `228f318c` |
| WORKFLOWS-5: multi-architecture tag guard | `e6dc98a6` |
| WORKFLOWS-6: failed export producer cleanup | `06a2aaec` |
| WORKFLOWS-7: macOS executable archive mode | `9aa1c644` |
| WORKFLOWS-8: public hardlink transfer | `e6ea69b7` |
| WORKFLOWS-9: extra empty draft attachment | `a39598ab` |
| WORKFLOWS-10: optional update-feed metadata | `467f8764` |

Final integrated verification at `3cd38f12`:

- The focused Python command ran 104 tests: 102 passed and two Linux-only
  metadata cases skipped on this macOS host. Modules: `test_guest_publication`,
  `test_workflow_pins`, `test_release_workflow`, `test_release_publication`,
  `test_publish_release`, `test_release_runtime_transfer`, `test_release_cache`,
  `test_release_metadata`, `test_linux_verification_release`,
  `test_debian_release`, and `test_macos_release`.
- `npm --prefix app/SiloUI run test:release`: 116 passed, 12 intentional skips.
  This run preceded the last two Python-only changes, whose publication fixtures
  were subsequently rerun in the final Python command.
- Lint, typecheck, Rust formatting, touched Python syntax, audit-relative links,
  and `git diff --check` passed. Actionlint validated all integrated workflows
  with only the previously documented supported-queue diagnostic suppressed.
- Evidence is local under `/tmp/silo-codex-target/verification/workflows/`,
  including each new failure log and `continuation-python-final.log`.

Permission declarations, credential-bearing steps, artifact paths, source-ref
handling, and required-job gates were reviewed again. Previously reported
findings remain excluded. The retired macOS 14 runner finding remains in the
existing release review; qualifying a replacement needs an external execution
environment. No application, VM, real credential, authenticated publication,
or registry write was exercised in this continuation.
