# Native entry micro-review

Scope: `app/SiloUI/src-tauri/src/main.rs`, `channel.rs`, and remaining top-level Rust files under 20 KB, including small application, bridge, startup/shutdown, window, directory, logging, identity, transport, and test-support modules. `lib.rs` does not exist in this checkout. Supporting caller reads were limited to establishing the findings below.

Evidence: read-only source inspection. Checked the first and second 2026-10-02 code reviews and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for prior findings. No builds, tests, native launches, or source modifications were performed.

## NATIVE-ENTRY-1: Directory snapshots accept a different VM with the same name

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/files.rs:55–59`, `files.rs:162–186`, and `files.rs:241–247`.
- **Trigger:** Obtain the first page of a directory with more than 200 entries for local VM A named `dev`. Within the snapshot's 120-second lifetime, delete A and create/start VM B with the same name, then request offset 200 using A's snapshot ID. A delayed pagination request can make the same transition.
- **Evidence:** `Snapshot.workspace` stores the request's sandbox name, and `cached_page` checks only that name, path, and age. Before serving a cached page, the command verifies that a current managed, running VM has the requested name, but never compares its metadata UUID with the snapshot owner. The snapshot cache is private to this module and has no lifecycle invalidation hook. Thus B satisfies the current-state checks and A's cached entries satisfy the cache checks.
- **Consequence:** The command returns A's directory entries as a successful listing for B. Displayed folders can belong to the deleted VM and fail when opened in B.
- **Suggested fix:** Resolve and retain the metadata VM UUID when creating each snapshot, and compare the current UUID before serving subsequent pages. Keep the snapshot ID for independent scans of the same VM.
- **Test that would catch it:** With a fake runtime and temporary metadata, fetch a 201-entry first page for UUID A/name `dev`; replace the metadata with UUID B/name `dev` and make B report managed/running. Request A's snapshot at offset 200 and assert the expired-listing error. Retain the existing test that independent snapshots for one VM paginate separately.

No additional concrete, unreported defect was established in `main.rs` or `channel.rs`.
