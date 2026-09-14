# Development workflow performance

2026-09-14. Changes implemented on `perf/development-workflows`; no application
version or published release changes. Timing observations are scoped to their
workload and runner, not universal guarantees.

## Implemented changes

- One reviewed runtime-input manifest feeds JavaScript staging and Rust
  provenance checks. Offline preflight runs before expensive work and tagging.
- Six native assertions moved into the existing unit-test harness, eliminating
  Cargo's integration-test-triggered normal application binary build.
- Twenty-five browser-independent frontend files use Node; remaining files
  retain jsdom and all behavior assertions. Worker limits remain global.
- Separate native and packaging jobs preserve all release gates and allow
  native compilation to overlap release compilation. An artifact-only
  sequential mode supports a same-commit comparison.
- Timing artifacts contain phase durations, CPU usage and peak child RSS only.
  Public runtime inputs are revalidated after cache restoration; compiled
  application outputs and private configuration are never shared by release jobs
  as caches.
- The patched-runtime cache key now includes embedded agent bytes. Its behavior
  regression proves reuse for identical bytes and rebuilding for changed bytes.

## Local evidence

| Workload | Before | After | Scope |
| --- | ---: | ---: | --- |
| Offline runtime preflight | unavailable | 28.85 ms median | 10 process-start-inclusive runs |
| Warm native compile | 8.36 s | 4.71 s | One controlled pair; same six assertions |
| Frontend suite | 67.33 s | 64.51 s | One controlled two-worker pair; same 757 tests |

See [native measurements](SiloUI-NATIVE-COMPILATION-EXPERIMENT.md) and
[frontend measurements](SiloUI-FRONTEND-TEST-PERFORMANCE.md) for commands,
hardware, evidence locations, invalid samples and interpretation limits.
Combined native verification passed 352 tests with 10 existing ignored tests;
updater verification passed 8 with one existing ignored test. The first local
sandbox run's four denied socket binds were preserved and passed with socket
permission. Synthetic configuration and fixture resources were used.

## Hosted comparison

Both artifact-only runs use commit `417deda` and identical test bodies, input
pins and instrumentation. The control runs native checks before release
compilation; the treatment runs the native matrix alongside package jobs.
Neither creates a draft, release tag or public update.

- [Sequential control](https://github.com/0xpolarzero/silo/actions/runs/34856238502)
- [Parallel treatment](https://github.com/0xpolarzero/silo/actions/runs/34856263771)

The expanded embedded-agent cache key causes an initial runtime rebuild in both
runs. Compare active workflow wall time separately from deliberate queue time,
and include the extra runner work required by the parallel native matrix.
The control completed in 24m19s of active workflow time. Its native checks
passed on all three targets; macOS and Linux x64 package jobs passed. ARM64
bundling failed when AppImage's type2 runtime download returned HTTP 504.
Consequently this is not a fully successful end-to-end control, and its
wall time must not be advertised as a successful-release baseline. The
parallel run will provide the remaining platform verification and phase data.

Control instrumentation (command wall times; excludes runner queue time):

| Target | Runtime preparation | Native checks, including compile | Updater checks | Release command |
| --- | ---: | ---: | ---: | ---: |
| macOS ARM64, 3 CPUs | 799.986 s | 194.881 s | 3.730 s | 351.875 s |
| Linux x64, 4 CPUs | 433.166 s | 116.001 s | 1.504 s | 281.455 s |
| Linux ARM64, 4 CPUs | 572.244 s | 152.158 s | 7.177 s | 320.265 s |

The release command includes normal runtime restaging, frontend preparation
and Rust compilation. The runtime cache-key correction accounts for the
initial cold preparation. The added bounded bundle-only retry recognizes the exact observed
AppImage runtime-download failure without repeating these compilation phases.
Eight deterministic regressions cover retry limits, permanent failures,
live stream forwarding, original exit codes and retention of every attempt.
The retry was added after the frozen comparison commit; its behavior was
verified against the original failure log and deterministic subprocesses.
Timing JSON is retained under `/private/tmp/silo-control-metrics/`; job
metadata is `/private/tmp/silo-control-run.json`.

## Not enabled

The isolated dependency-cache probe is not used in production. An actual
optimized Tauri control/population/readonly sequence took 68.887 / 68.599 /
91.239 seconds despite five consumer hits and byte-identical executables.
Uncached work also slowed, so this does not establish a stable cache penalty;
it does fail to establish the required gain. A cache must
reduce end-to-end time after transfer/wrapper overhead, preserve rebuilds under
configuration changes, and exclude application/signing configuration. A tiny
cache hit alone does not establish that case.
