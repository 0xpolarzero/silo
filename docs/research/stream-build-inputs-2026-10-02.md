# Streaming build inputs, 2026-10-02

O-02 is confirmed in the original staging code: guest archive verification uses
`readFile`, and the preparation callbacks use `Response.arrayBuffer`. The image
lock pins 414,843,188-byte ARM64 and 423,476,714-byte AMD64 compressed archives.
Baseline source: `c3b8b7f692ba7efa1b097926dfe47aaa378f549f`.
No production memory failure was reproduced.

## Implementation and primary sources

Use Node 24's maintained built-in file and stream APIs. No dependency, proxy,
download manager or archive parser is added. The existing system `tar` remains
the extraction adapter.

- [`stream/promises.pipeline`](https://nodejs.org/download/release/v24.11.1/docs/api/stream.html#streampipelinesource-transforms-destination-options)
  provides backpressure, propagates stream failures, and destroys streams on
  cancellation. [`Readable.fromWeb`](https://nodejs.org/download/release/v24.11.1/docs/api/stream.html#streamreadablefromwebreadablestream-options)
  adapts the built-in fetch response body without collecting it.
- [`Hash.update`](https://nodejs.org/download/release/v24.11.1/docs/api/crypto.html#hashupdatedata-inputencoding)
  accepts successive chunks. Verify SHA-256 and byte counts before publication.
- [`AbortSignal.timeout`](https://nodejs.org/download/release/v24.11.1/docs/api/globals.html#static-method-abortsignaltimeoutdelay)
  supplies one 10-minute deadline to fetch and the write pipeline, including
  response headers, redirects and body consumption. Cached verification also
  has a 10-minute deadline.
- [`mkdtemp`](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesmkdtempprefix-options)
  creates an exclusive staging directory beside the destination. The pipeline
  writes with `wx`, closes the file, and publishes with
  [`rename`](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrenameoldpath-newpath).
  Normal failures remove staging files. This provides atomic file visibility,
  not power-loss durability or an atomic archive/manifest transaction.

The verifier rejects data as soon as it exceeds the guest lock's exact length,
even without a Content-Length header. It rejects short bodies and bad hashes
before rename. Other runtime inputs have pinned hashes but no pinned lengths;
they use a 1 GiB cap, with a 4 MiB cap for license downloads. These limits require
review when replacing pins. Local guest artifacts are verified while copying,
and a missing or corrupt candidate falls back to a streamed download. Write or
publication errors propagate instead of triggering another download.

MicroSandbox source archives now reach the build adapter as verified file paths;
Git and Git LFS already extract files and now reuse their verified cache files
directly. Runtime libraries and license files use file copies. Compiled
executables and the embedded agent remain byte buffers in the existing compiler
adapter; this change removes complete input archives and fetch-body buffers.

## Synthetic measurements

Host: Apple M4 Max, macOS ARM64, Node v24.11.1. Input: 423,476,714 bytes of repeated
`0x61`, generated in 64 KiB chunks and pinned by length and SHA-256. Its contents
are irrelevant to staging because this path verifies and copies compressed
archives without decompressing them.

Each sample runs actual `stageGuestImage` in a fresh process. Cold means no
staged or local artifact; a loopback HTTP server in that process streams the
fixture through the production download adapter. Warm means an already staged
verified file. Local means only an approved local artifact exists. Fixture setup
and cleanup are outside the timed interval. Peak RSS uses
`process.resourceUsage().maxRSS`, including the loopback server for cold samples.
The OS file cache is warm; this is not a disk-cache-cold benchmark.

Five samples per version and mode, alternating before and after, yielded these
medians:

| Staging mode | Before peak RSS (MiB) | After peak RSS (MiB) | Before time (ms) | After time (ms) |
| --- | ---: | ---: | ---: | ---: |
| Cold loopback download | 1,352.2 | 184.4 | 953.3 | 514.5 |
| Warm verification | 461.2 | 160.1 | 197.6 | 220.4 |
| Approved local artifact | 462.1 | 155.8 | 607.7 | 224.0 |

Cold peak RSS fell 86%; warm peak RSS fell 65%. Warm verification added about
23 ms in the median. The shared host was running other work: cold before samples
ranged from 558 to 3,640 ms, and after from 443 to 994 ms. Timings establish the
cost in this synthetic run and do not establish a network or release-build
speedup. Full runtime preparation, compilation, extraction and upstream network
downloads were not measured or run.

The disposable harness, baseline module, raw JSON samples and failing output are
under the worktree's ignored
`app/SiloUI/src-tauri/target/verification/o02-stream-build-inputs/` directory.
The harness accepts `setup`, or `before|after cold|warm|local`; it never runs
`runtime:prepare`. The final comparison is `comparison.jsonl`. Initial three-run
measurements are retained as `before.jsonl`, `after-first.jsonl` and `after.jsonl`.

## Regression coverage and checks

The child-process RSS test creates a 256 MiB cached guest archive and requires
verification to increase peak RSS by less than 192 MiB. The original module
fails at 259.34 MiB; the streaming module passes. The threshold leaves room for
Node and allocator variation while rejecting a complete archive-sized buffer.
This test runs in `test:release` and uses only a disposable fixture directory.

Behavior tests cover chunked download, cache reuse, verification before
publication, short bodies, changed bytes, interrupted streams, early oversized
stream termination, temporary-file cleanup, local corruption fallback,
publication failure, HTTP errors, and deadlines both before headers and during
the body. Existing MicroSandbox, Git and guest staging tests use stream fixtures;
the MicroSandbox build adapter test confirms it receives the verified source
file. The built-in pipeline is the tested cancellation and backpressure seam.

Validation before folding:

- `npm --prefix app/SiloUI test -- src/test/guest-image.test.ts src/test/git-runtime.test.ts src/test/microsandbox-runtime.test.ts`: 33 passed.
- `node --test` on `build-input.test.mjs`, `guest-image.test.mjs` and `guest-image-memory.test.mjs`: 14 passed.
- `npm --prefix app/SiloUI run test:release`: 83 passed, 12 existing opt-in tests skipped, zero failures.
- `python3 -m unittest app/SiloUI/scripts/test_release_cache.py app/SiloUI/scripts/test_release_runtime_transfer.py`: 11 passed.
- Typecheck, focused lint, `cargo +1.94.0 fmt --check`, `git diff --check` and the new relative documentation link passed. Full lint passed with 12 existing warnings in unrelated UI files.

After reconciling the Git LFS compiler-identity cache change from integration,
the combined streaming/cache tests passed all 34 tests, focused Vitest still
passed 33 tests, release scripts passed 98 tests with 12 opt-in skips, and the
packaging/cache Python checks passed 12 tests. Typecheck, full and focused lint,
Rust format and diff checks passed; integration had resolved the earlier UI lint
warnings.

No app bundle, production state, Keychain, VM, or installed-app behavior is
exercised.
