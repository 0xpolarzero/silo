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
parallel run passed all native jobs plus macOS and ARM64 packaging; its x64
bundler failed downloading linuxdeploy with the same upstream HTTP 504 class.
Every platform therefore passed package verification in one of these two
same-commit runs, but neither entire workflow was green.

Control instrumentation (command wall times; excludes runner queue time):

| Target | Runtime preparation | Native checks, including compile | Updater checks | Release command |
| --- | ---: | ---: | ---: | ---: |
| macOS ARM64, 3 CPUs | 799.986 s | 194.881 s | 3.730 s | 351.875 s |
| Linux x64, 4 CPUs | 433.166 s | 116.001 s | 1.504 s | 281.455 s |
| Linux ARM64, 4 CPUs | 572.244 s | 152.158 s | 7.177 s | 320.265 s |

The release command includes normal runtime restaging, frontend preparation
and Rust compilation. The runtime cache-key correction accounts for the
initial cold preparation. The added bounded bundle-only retry recognizes the
observed AppImage runtime and Tauri tool-download failures without repeating
these compilation phases.
Eleven deterministic regressions cover retry limits, permanent failures,
live stream forwarding, original exit codes and retention of every attempt.
The retry was added after the frozen comparison commit; its behavior was
verified against the original failure log and deterministic subprocesses.
Timing JSON is retained under `/private/tmp/silo-control-metrics/`; job
metadata is `/private/tmp/silo-control-run.json`.

## Scheduling result and adoption

| Observation | Sequential control | Parallel treatment |
| --- | ---: | ---: |
| Active workflow wall time | 24m19s | 18m16s |
| Successful macOS package job | 23m57s | 18m01s |
| Sum of non-skipped job wall times | 66m16s | 95m49s |
| Native tests and updater checks | All targets passed | All targets passed |
| Package verification | macOS + x64 passed; ARM64 download 504 | macOS + ARM64 passed; x64 download 504 |

The observed workflow difference was 6m03s. It is **not** a clean successful
release comparison or a statistically established speedup. On macOS, parallel
scheduling removed 198.611s of serial native/updater work, while runtime
preparation independently fell by 176.636s and the release command rose by
31.776s. These phase differences explain why the whole improvement cannot be
attributed to scheduling. Frontend job time also varied, from 140s to 201s.

**Keep the native/package split as the release default.** The independent
native jobs passed all three platform gates. macOS package checks passed in
both runs, and its parallel native checks finished before packaging. The draft
still requires every verification branch. The verified structural improvement is removal of serial native work
from each package job; the observed six-minute difference is not a guarantee.
This choice prioritizes developer elapsed time over cold-run runner usage.

Cold preparation ran twice per target in the treatment. Of its additional
29m33s of summed job time, 28m07s came from duplicated runtime preparation.
The existing credential-free main-branch warmer prepares these public inputs
for ordinary releases; the corrected cache key requires one initial warm.
The remaining runner overhead and queue behavior should be assessed from
normal warm releases before adding more workflow complexity.

The [sanitized phase and job metrics](measurements/workflow-2026-09-14.json)
are committed for durable comparison. Original parallel phase metrics are
retained in `/private/tmp/silo-parallel-metrics/`, and job metadata in `/private/tmp/silo-parallel-run.json`. Both runs used
`417deda`; later commits add toolchain selection from the same manifest value,
focused regressions and the bounded bundle retry. The retry is verified using
the two exact diagnostic shapes and deterministic subprocesses. It has not
been claimed as a live successful retry in these earlier runs.

## Warm runtime measurement

The main-branch warmer [34864569539](https://github.com/0xpolarzero/silo/actions/runs/34864569539)
completed successfully on all three platforms. The subsequent artifact-only
release run [34866074365](https://github.com/0xpolarzero/silo/actions/runs/34866074365)
at `e50ee59` passed every native, frontend, packaging, signature and metadata
check. It did not publish a release. Active workflow time was **9m32s**, with
39m59s summed job time. This replaces the earlier approximately eight-minute
estimate with a measured result.

| Package job | Complete job | Runtime preparation command | Release build command | Initial bundling |
| --- | ---: | ---: | ---: | ---: |
| Linux x64 | 9m23s | 3.110 s | 362.096 s | 92.326 s |
| Linux ARM64 | 7m47s | 1.206 s | 280.753 s | 96.902 s |
| macOS ARM64 | 6m59s | 1.765 s | 343.738 s | 7.178 s |

The macOS runtime composite step, including cache restoration, fell from
630s in the earlier cold parallel run to 7s. Its preparation command fell
from 623.350s to 1.765s. Native-job preparation also took only 1.240–3.021s;
all six consumers reused the prepared runtime. This directly demonstrates
that unchanged runtime compilation can be removed from ordinary releases.

The overall observed difference from the cold parallel benchmark is 8m44s
(48%). That earlier run failed a Linux download, used an earlier commit, and
had different runner/compiler timings, so it is not a controlled successful
release speedup claim. The phase measurements establish runtime reuse;
the whole-run number describes this successful warm run.

Linux x64 now determines completion. Its longest steps were compilation
(362s), bundling (92s), installing native prerequisites (36s), collecting and
checking Linux assets (25s), and uploading packages (11s). Native jobs
finished in 4m01s–4m19s and frontend checks in 3m13s. They overlap packaging.
The remaining priority is application dependency compilation, followed by
Linux packaging. The [sanitized full job and phase timings](measurements/workflow-warm-2026-09-14.json)
contain the complete breakdown; raw logs remain local.

### Shared cold-runtime workflow validation

Commit `6be2779` moves each platform's native/package jobs into a reusable
workflow with a conditional public-runtime producer. Exact cache lookups run
inside the existing validation job. On a miss, the producer prepares the
runtime once and passes only the existing public-cache allowlist to both
consumers. Each consumer still verifies and stages the inputs. On a hit, the
producer is skipped and both consumers start independently. Cache eviction or
corruption after lookup still falls back to normal verified preparation.

Hosted run [34867497410](https://github.com/0xpolarzero/silo/actions/runs/34867497410)
passed all checks in **9m27s**. All three producers were skipped; the three
lookups took 3s combined inside the existing validation job. macOS cache lookup
from the Ubuntu validation runner worked. This confirms the warm scheduling,
environment configuration, and publication prerequisites on the real service.
It does not claim a hosted cold-miss transfer measurement. Seven deterministic
transfer/scheduling tests cover one producer feeding two consumers, executable
mode preservation, excluded files, checksum/path/link rejection, and producer
failure blocking consumers. The full Python release-tooling suite passed 65
tests; workflow syntax validation and an independent review passed.

## Accepted public dependency artifacts

The [fresh-runner benchmark](https://github.com/0xpolarzero/silo/actions/runs/34869018584)
at `6f45d5c` passed on all three platforms. Each platform compiled a cold
synthetic release, exported only checksum-approved crates.io dependency units,
then restored them on a new runner with changed synthetic app configuration.
No application, workspace/path crate, or application build-script output was
transferred. Source bytes were checked before restoring their timestamps.

| Platform | Cold compilation | Cached compilation | Transfer + validation + restore | Cached total | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| macOS ARM64 | 327.632 s | 135.075 s | 74.198 s | 209.273 s | 36.1% |
| Linux ARM64 | 277.499 s | 86.105 s | 43.430 s | 129.535 s | 53.3% |
| Linux x64 | 358.814 s | 94.492 s | 37.883 s | 132.375 s | 63.1% |

All 531 macOS and 619 Linux registry compilation units were fresh in the
consumers. Every application recompiled, contained its new configuration
marker and excluded the producer marker. Every platform exceeded the 30%
transfer-inclusive adoption threshold in this pair. These are compilation
measurements, not whole-release durations or guarantees across future runner
loads. [Sanitized comparison reports](measurements/dependency-cache-2026-09-14.json)
retain the precise values and verification results.

Production integration uses the existing main-only synthetic warmer to save
audited dependency outputs. Packaging jobs restore only, fall back cold on a
missing or rejected cache, and require fresh app compilation. A dedicated
`src-tauri/target/release-compile` directory separates these outputs from
runtime preparation and native tests. Compiler/SDK/feature/dependency identity
remains exact; only the root app version is normalized to permit reuse across
app releases. Identity is computed before artifact-only signing-key mutation.
Native tests, signatures, package checks and draft prerequisites are retained.

### Complete cached release result

The final [artifact-only release verification](https://github.com/0xpolarzero/silo/actions/runs/34872424212)
passed every gate in **6m15s from dispatch**, or **6m11s from the first job's
start**. Compared consistently with the successful runtime-only warm run's
9m27s active duration, this saved **3m16s (34.6%)**. Summed job time was
31m10s, down from 39m59s in the earlier warm run; this is unweighted runner
work, not billed minutes. Runtime and dependency caches were populated before
the final run. Cold misses still require compilation.

| Package job | Complete job | Release compilation | Dependency download + validation/restore | Runtime preparation | Initial bundling |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux x64 | 5m56s | 113.798 s | 18 s | 3.231 s | 94.816 s |
| Linux ARM64 | 5m46s | 99.162 s | 16 s | 1.223 s | 100.236 s |
| macOS ARM64 | 4m57s | 145.209 s | 30 s | 2.631 s | 6.642 s |

The full release command includes normal frontend preparation/runtime
restaging in addition to Rust compilation. All three production restore steps
reported verified cache restoration, followed by mandatory fresh application
compilation. Earlier cache miss/rejection messages in the same logs came from
the deterministic fallback tests, not the production restore steps. All native
jobs passed (3m13s–4m01s), as did frontend checks (3m15s), minimum-macOS checks,
package creation, signing and metadata checks. These jobs overlap.

A concurrent 0.5.0 release changed the runtime inputs and occupied the shared
publication queue. The initial unpinned artifact run `34871663613` was cancelled
while pending; the active publication was left untouched. Artifact-only runs
now have independent concurrency and can pin their source. The measured final
run used workflow `d9850de3341f4cec78f055334d208b401d8e9334` and source
`a29b211e0da084c8fe1b0cd84135b9ad2ef3b822`, keeping the compiled source and warmed
inputs fixed. No release was published by this benchmark. Five focused tests
cover source validation and checkout/concurrency wiring; the prior complete
release-tooling suite passed 96 tests.

The [complete sanitized job/step and phase timings](measurements/workflow-cached-2026-09-14.json)
record the breakdown. The approximately 66% observed reduction from the earlier
18m16s cold run combines runtime reuse and dependency reuse; that cold run had a
failed download and is not a successful-release control. The successful warm
9m27s to 6m11s comparison is the end-to-end result for this round, not a promise
of a minimum duration on every runner.

## Rejected narrow Rust cache

The dependency-cache candidate was rejected and its prototype removed from
the final source tree and routine CI; local experiment evidence is retained.
An actual optimized Tauri control/population/readonly sequence took 68.887 / 68.599 /
91.239 seconds despite five consumer hits and byte-identical executables.
Uncached work also slowed, so this does not establish a stable cache penalty;
it does fail to establish the required gain. A cache must reduce end-to-end time after transfer/wrapper overhead, preserve rebuilds under
configuration changes, and exclude application/signing configuration. A tiny
cache hit alone does not establish that case.

## Evidence retention

Discarded experiment products and caches consumed 11,849,654,272 allocated
bytes (about 11 GiB) and were removed. Cargo timing HTML, extracted unit JSON,
logs, statistics, hash inventories and runners remain in
`/private/tmp/silo-native-perf/` (29 MiB). The detailed cleanup inventory is
`preserved-evidence/cleanup-manifest.json`; preserved Cargo reports are under
`preserved-evidence/`. The user's original Cargo target and runtime cache were
kept warm.
