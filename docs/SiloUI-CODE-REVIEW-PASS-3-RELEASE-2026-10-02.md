# Silo third code review pass: release and CI, 2026-10-02

This pass reviews release tooling, workflow gates, updater artifacts, release documentation, and development/production channel separation. Findings are added as their evidence is confirmed; an empty ledger is not a release-readiness claim.

## Revision and scope

Initial revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-release-ci`. Each finding records its confirmation and subsequent fix separately because integration changes during this pass.

The first two reports were read from the main checkout before review. This ledger excludes R-01 through R-38 and previously recorded improvement opportunities, including APT retention (R-13), website/demo CI coverage (R-14), LFS compiler identity (R-20), and independent draft-asset authentication (O-11).

Reviewed boundaries: `app/SiloUI/scripts/`, `.github/workflows/`, `.github/actions/prepare-release-runtime/`, updater configuration and asset contracts, `docs/SiloUI-RELEASES.md`, and host names defined by `src-tauri/src/channel.rs`.

P1 denotes an essential delivery or isolation failure; P2 denotes a concrete correctness, availability, or verification failure; P3 denotes a narrower defect with a practical workaround. Evidence distinguishes executed fixture behavior from source-confirmed consequences.

No release is published, signed, tagged, or pushed. No runtime preparation, app launch, real VM, production HOME, or credential store is used. Tests use synthetic inputs and temporary paths.

## Findings at a glance

| ID | Priority | Finding | Status |
| --- | --- | --- | --- |

## Detailed findings

## Verification and reproducibility

Review in progress. Focused tests and exact failure/passing results will be recorded with each finding. Native checks use the shared `/tmp/silo-codex-target`; Node dependencies use the existing main-checkout installation. A fixture or source review does not qualify a signed release or installed application.

## Next action

Trace release validation through platform artifacts and publication, then check host-name consumers against both build channels.
