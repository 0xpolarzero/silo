# Release dry run, 2026-09-30

The release verification session covers A-01, A-04, A-08 and A-09 from the
[review remediation plan](../SiloUI-REVIEW-REMEDIATION-PLAN.md#live-verification-sessions).
It follows [the release procedure](../SiloUI-RELEASES.md).

## Dispatch safety

Inspected `release.yml`, `release-platform.yml`, `release-tooling.yml`, the
`prepare-release-runtime` action, and the separate publication workflows before
requesting any build. `workflow_dispatch` with `draft=false` and
`benchmark_schedule=parallel` builds every target and uses fresh test updater
signing keys in `release-verification`. The draft job is gated on `draft=true`;
no GitHub release or tag is created. APT/Pages listens to the separate
`Publish verified Silo draft` workflow, and guest-image publication is separate.
The normal `main` push does not trigger those publication workflows.
Test packages are Actions artifacts retained for seven days, not distributable
updates. No production signing key was selected, and no signing material or
private configuration is included in this record.

## Commands and runs

The owner authorized a non-force `git push origin main`, which succeeded from
`5ce17702` to `091b6d7eb08621fa638e3bed8fcfff7a1bbb0afc`. No tags were pushed.

```sh
gh workflow run release.yml --ref main -f draft=false -f benchmark_schedule=parallel
gh run watch 36733920276 --exit-status --interval 30
gh run view 36733920276 --json status,conclusion,headSha,url,jobs
```

- Source and workflow commit: `091b6d7eb08621fa638e3bed8fcfff7a1bbb0afc`.
- [Run 36733920276](https://github.com/0xpolarzero/silo/actions/runs/36733920276),
  dispatched 2026-09-30 at 15:04:20 UTC; failed at 15:39 UTC.
  macOS runtime/native/updater/package checks passed; Linux x64 runtime/package
  checks passed but native tests failed; Linux ARM64 runtime passed, native tests
  and AppImage bundling failed. Draft creation was skipped.

## Failure diagnosis and fixes

`gh run view 36733920276 --log-failed` was saved locally after completion.
While the workflow was active, completed job logs were retrieved through the
GitHub Actions jobs API because `gh run view --log-failed` refuses active runs.
The original failed output remains in `/tmp/silo-codex/release-verification/`;
private logs are not committed or uploaded.

Both Linux native suites passed 1,038 tests, failed two, and ignored 14:

- `remote::setup_tests::public_key_install_works_from_any_login_shell` panicked
  with `no non-POSIX shell to test`. Install `fish` in the Linux release native
  and sequential-test package jobs, ordinary CI Rust job, and Linux verification
  job; retain the test's required non-POSIX coverage.
- `runtime::tests::resolving_runtime_paths_does_not_require_runtime_files_or_manifest`
  expected `/usr/libexec/silo/tools/libkrunfw.so.5.6.1` but got
  `/usr/bin/libkrunfw.so.5.6.1`. The fixture incorrectly supplied the app executable
  to a function called with the bundled `msb` in production. Resolve the managed
  tool directory through the existing resolver, then pass its `msb` path.

Linux ARM64 compiled successfully, then AppImage bundling failed with
`xdg-open binary not found /usr/bin/xdg-open`. Install `xdg-utils` in the release
package job and ordinary Linux packaging workflow. Ubuntu's
[`xdg-utils` file list](https://packages.ubuntu.com/noble/all/xdg-utils/filelist)
confirms the package supplies `/usr/bin/xdg-open`.

Fix commit: `8c0c6813` (`fix(ci): install Linux verification prerequisites and
correct runtime fixture`), pushed without force. These are internal verification
and build-environment fixes; no changeset, version bump or tag was created.

Local checks passed:

- `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`.
- `python3 -m unittest discover -s app/SiloUI/scripts -p 'test_*release*.py'`:
  121 tests.
- Discovery of `test_release_cache.py` and `test_workflow_pins.py`: six tests.
- `python3 app/SiloUI/scripts/check-command-manifest.py` and `git diff --check`.
- The two focused Cargo tests with synthetic GitHub values, using an absolute
  isolated `CARGO_TARGET_DIR` under `src-tauri/target/release-verification`.
  The ordinary shared target initially failed because generated plugin-permission
  paths referenced a removed worktree. Its output was preserved; the target was
  not cleared. Both tests passed in the isolated target. The Linux-only path
  assertion requires the subsequent hosted Linux suites for execution proof.

## Results

[Run 36738500497](https://github.com/0xpolarzero/silo/actions/runs/36738500497)
was dispatched at 15:40:12 UTC using the same non-draft parallel command after a
second fast-forward `git push origin main`. Source and workflow commit:
`54d38f16d4e6d0114014cdc7f8b6248a2829e609`. This includes the release fixes and
the concurrent Linux worker's commits `7bf080c8` and `54d38f16`; it is a new
all-target verification rather than a retry of old source. Frontend failed
because `src/test/microsandbox-runtime.test.ts` asserted exactly 11 patches after
the concurrent SFTP fix correctly added a twelfth; 1,580 frontend tests passed
and one failed. The run finished at 16:23 UTC with macOS and ARM64 native/updater
checks and all three package jobs passing. Linux x64 native tests were never
reached: the runner spent its 30-minute job budget downloading 209 MB of default
recommended dependencies and was cancelled while fetching `pocketsphinx-en-us`.
The failed run and completed cancelled-job log were preserved locally.

Commit `d8887d00` (`fix(ci): align demo fixtures and bound Linux dependency
installation`) adds `--no-install-recommends` to the release native/package
Linux dependency steps, matching existing CI and Linux packaging practice while
retaining every explicit dependency, including `gstreamer1.0-libav`, `fish`, and
`xdg-utils`. No timeout increase or removed native check hides the failure.

The exact frontend failure was reproduced locally with
`npm --prefix app/SiloUI test -- src/test/microsandbox-runtime.test.ts` (12 passed,
one failed). Commit `c55c3c12` (`test(runtime): remove stale patch count assertion`)
removes only the obsolete numeric total; patch-byte hash verification and
retention-source equality remain enforced. The focused suite then passed all
13 tests; `npm --prefix app/SiloUI run typecheck` and `npm --prefix app/SiloUI run lint`
passed (lint reported five existing warnings), as did `git diff --check`.
This internal test correction needs no changeset and was pushed without force.

[Run 36744237541](https://github.com/0xpolarzero/silo/actions/runs/36744237541)
was dispatched at 16:26:41 UTC on
`d8887d00aff42ac0370cdc6eea9b94b1d56ab20b`, again with `draft=false` and
`benchmark_schedule=parallel`. **Passed**, finishing at 16:34:57 UTC:
nine required jobs succeeded; the three redundant runtime producers were skipped
on exact cache hits, and draft creation was skipped.

Final per-target results:

| Target | Native and updater tests | Package, signature and metadata checks |
| --- | --- | --- |
| macOS ARM64 (`aarch64-apple-darwin`) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986319089) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986318878) |
| Linux x64 (`x86_64-unknown-linux-gnu`) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986318969) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986318995) |
| Linux ARM64 (`aarch64-unknown-linux-gnu`) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986318873) | [Passed](https://github.com/0xpolarzero/silo/actions/runs/36744237541/job/109986318845) |

The shared frontend release checks and minimum macOS 14 library-constraint job
also passed. Packages use version `0.9.0` and the isolated test updater key.
The macOS job verified
`app/SiloUI/src-tauri/target/release-compile/aarch64-apple-darwin/release/bundle/macos/Silo.app`
and regenerated its DMG and signed app archive. Linux jobs inspected the Debian
and AppImage bundles under the corresponding target's `release/bundle/` directory.
No local app was launched and no live VM data was used.

Final artifacts are exactly `release-macos-arm64`, `release-linux-x64`,
`release-linux-arm64`, six native/package timing artifacts, and
`macos-14-library-constraints`. No diagnostic log or private configuration artifact
was uploaded. GitHub release IDs/tags/draft/publication dates and remote Git tags
were unchanged between the first dispatch and the completed third run. No GitHub
release, tag, APT/Pages/updater publication, or guest image was published by this
session.

The first run's artifact inventory contained public runtime cache archives,
runtime/native/package timing JSON, the macOS 14 constraint result, and the
successful `release-macos-arm64` and `release-linux-x64` test packages. There was
no `bundle-diagnostics-*`, verbose bundle log, Cargo target tree, or local
configuration artifact, including after the ARM64 signing/bundling failure.

## Push-triggered CI follow-up

The owner added CI verification to this session after observing
[CI run 36739113515](https://github.com/0xpolarzero/silo/actions/runs/36739113515)
on `c55c3c12dc7b0bb46ea3baba557894e40356c9d1`. Its failed log was retrieved with
`gh run view 36739113515 --log-failed` and preserved locally. Rust tests passed;
website typechecking and documentation links failed.

- Website fixtures lacked `checkpointHostBytes`, `checkpointCount`, and the
  required `WorkspacesPage.source`. Supply explicit zero checkpoint totals and
  the existing read-only source.
- Local `demo` typechecking then exposed the same missing `source` and obsolete
  `BackupActions.retryStart` fixtures. Pass the existing source, remove the
  obsolete action, and provide an `exportAndVerify` action that rejects native
  exports from video fixtures.
- The historical Linux verification document linked an ignored generated runtime
  manifest. Point it to the tracked `runtime-inputs.json` source instead.
- The other missing link targeted the concurrent Linux session record, now
  committed by its owner in `09b33ae6`; no edit or staging of that record was
  needed here.

These fixes are in `d8887d00`. Both `website` and `demo` typechecks passed,
release-cache/workflow-pin tests passed, and the existing website test
`shows fixture files, logs, network and settings without network requests`
passed. The pinned lychee 0.24.2 binary was downloaded from its official release,
SHA-256 verified, and run with the CI glob arguments against a clean `git archive`
of `d8887d00`: 1,842 links, zero errors. A prior check against the working tree
included ignored third-party `node_modules` documents; the clean archive matches
CI's checkout boundary.

[CI run 36744180995](https://github.com/0xpolarzero/silo/actions/runs/36744180995)
was triggered by the fast-forward push of `d8887d00` and passed: Rust tests,
frontend and scripts, and documentation links all succeeded.

## Verification boundaries

A-01 requires both Linux package jobs to finish Debian assembly and checks.
A-04 requires clean-checkout native compilation and command-manifest checks.
A-08 is supported by workflow inspection: GitHub App configuration is scoped to
the configuration check and compilation; the parallel native suite uses
synthetic values; updater signing keys are scoped to signing steps. This
verification does not exercise the production key.
A-09 is supported by the artifact upload allowlist and the final artifact
inventory: verbose bundle logs must remain on the runner.

Hosted build success proves compilation, packaging and the supplied automated
checks. It does not prove installed-app behavior, VM health, a production-key
update, SIP-enabled macOS signature enforcement, or release readiness. The
remediation plan is not modified by this session.
