# Retained logs

Silo searches the retained history on the computer that owns each sandbox.
The 200-record page size limits one response, not the search range. Application
state refreshes no longer fetch log tails for every sandbox.

## Retention

The bundled runtime retains execution, runtime and kernel output for at most
seven days with a shared 250 MiB budget per sandbox. It removes the oldest
segments when either limit is reached. Segments rotate at 10 MiB or one day.
Expiration uses the segment's first-write time, so newer records in an old
segment can expire up to a day early. The limits apply to raw runtime files;
they do not establish a minimum guaranteed investigation window.

Running sandboxes enforce retention in their runtime. Silo also cleans up logs
for sandboxes confirmed stopped. Cleanup does not start a VM. An old runtime
process must restart onto the updated bundled runtime to use the new writer.
Idle running sandboxes check expiration every minute.

Logs belong to the sandbox's runtime directory. An exported file is a separate
user-owned copy and is not removed by log retention. Lifecycle, setup and secret
Activity journals remain separate from diagnostic logs and retain their existing
count limits.

## Search and investigation

Select sandboxes in Logs, enter text, and optionally choose a source and date
range. Search runs against retained files, including rotated segments and stopped
sandboxes. The view reports matching record counts. Older
records load in pages. Follow refreshes the latest results; pause before browsing
older pages. Surrounding logs show nearby records without the search filter.
Activity entries can open the associated time window.

Each record preserves computer and sandbox identity, timestamp, source and
execution session when available. Legacy runtime and kernel lines without
timestamps use the file timestamp and are marked as estimated. Unavailable
computers and expired pagination snapshots produce explicit errors, not invented
log entries. New writes do not shift an existing page sequence.
Search snapshots expire after 30 minutes without use and can be evicted under
memory pressure. Refresh to begin a new snapshot. Search indexes store record
offsets rather than log bodies, with a shared 128 MiB index budget; an oversized
query returns an explicit request to narrow its time range or search text.

Copy copies the records currently fetched, with identifying context.
Export… saves all matching pages through the native save dialog as JSON
Lines. It includes coverage metadata and complete record identities. Export
queries each sandbox as a separate snapshot. Cancellation or a failed page leaves
the selected destination untouched and removes partial output.

The display and export use marker-based sensitive-output filtering. Raw runtime
files can contain private application output; this filter is not a guarantee
that arbitrary secrets are removed. Review exports before sharing them.

## Implementation

- [Query adapter](../app/SiloUI/src-tauri/src/runtime_logs.rs): local retained
  files, search, pagination, surrounding records and remote owner routing.
- [Retention policy](../app/SiloUI/src-tauri/src/log_retention.rs): segment age,
  shared byte budget and stopped-sandbox cleanup.
- [Runtime patch](../app/SiloUI/patches/microsandbox-create-stopped-0.6.17.patch):
  execution, runtime and kernel writers.
- [Logs view](../app/SiloUI/src/features/application/pages/logs-page.tsx):
  history search and bounded rendered rows.
- [Native export](../app/SiloUI/src-tauri/src/log_export.rs): paginated,
  cancellable, atomic file export.
- [Original audit](SiloUI-LOGGING-AUDIT.md): the preceding behavior and findings.

## Verification

Deterministic backend tests cover an error behind 100,000 newer records,
pagination during appends and rotation, in-place truncation and replacement,
source/time filters, surrounding records, non-UTF8 console output and long
messages. Paging all 100,002 synthetic records took approximately 3.4 seconds
in a local debug run. Export tests cover complete pagination, identity,
cancellation, failed writes and a non-advancing remote cursor. UI tests cover
search, bounded rendered rows, owner failures and follow/pause.

Final verification on 2026-09-18:

| Check | Result |
| --- | --- |
| `npm --prefix app/SiloUI test` | 827 tests passed across 90 files |
| `npm --prefix app/SiloUI run lint` | Passed |
| `npm --prefix app/SiloUI run build` | TypeScript and production frontend build passed; Vite reports a large-chunk advisory |
| `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml` with explicit synthetic GitHub configuration | 416 passed, 11 ignored |
| Patched upstream runtime | Compiled; nine logging tests, kernel pipe ownership test and synchronous storage-failure test passed |
| Upstream SDK log streams | Six tests passed, including archives beyond the previous four-file discovery limit |
| Runtime staging | 13 tests passed; final patch applied to the pinned archive and matched intended sources |
| `npm --prefix app/SiloUI run test:release` | 34 release-tooling tests passed |
| Browser fixture | Inspected layout, visible dates, search and surrounding-record navigation |

Generated test output is under the ignored
`app/SiloUI/src-tauri/target/verification/logs-*-tests*.log` paths. These tests
establish behavior for their supplied data; they do not prove a running installed
app, Linux VM console capture or a live two-computer workflow. No packaged bundle
was built or inspected. No running user VM was stopped or changed for verification.

Subsequent native preview on 2026-09-18: `npm --prefix app/SiloUI run
desktop:build:debug` built the debug bundle at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. Launching this exact
bundle exposed missing Tauri permissions for the three log commands. The command
manifest and main-window grants were fixed; three regression tests passed, along
with nine focused Logs tests, typecheck and lint. The rebuilt app was launched
and its Logs view inspected against actual local state: the query completed
without a permission error and returned no records. Retention and search-scope
commentary were removed from the view. No VM was started for this preview.
