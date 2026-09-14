# Frontend test environment measurement

2026-09-14. Split 25 browser-free suites (158 tests) into a Node project and retain 58 jsdom suites (599 tests). Test bodies, full-window journeys, DOM implementation, isolation, timeouts and the default four-worker limit are unchanged. Unclassified files retain jsdom. Only the DOM project loads `src/test/setup.ts` and its browser stubs and matchers.

## Controlled local pair

Measured in an isolated worktree based on `40c7a4522e9a90aad9c888a35d5a3df8610fd6fb`, including the concurrent runtime-input implementation with its import fix held stable for the pair. Host: Apple M4 Max, 16 CPUs, arm64, macOS 26.5, Node 24.11.1, Vitest 4.1.11. Dependencies were installed; no native compilation ran during either measurement. These are local results, not GitHub runner results.

Both runs used this command from the repository root, with `LABEL` replaced by `baseline-fixed` or `treatment-fixed`:

```sh
/usr/bin/time -p npm --prefix app/SiloUI test -- --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=src-tauri/target/verification/frontend-perf/LABEL.json
```

| Measurement | All jsdom baseline | Node/jsdom treatment |
| --- | ---: | ---: |
| Passed files / tests | 83 / 757 | 83 / 757 |
| Vitest wall time | 67.33 s | 64.51 s |
| Process wall time | 67.70 s | 64.88 s |
| Aggregate environment setup | 20.49 s | 14.42 s |
| Aggregate test setup | 2.68 s | 1.91 s |
| Aggregate test execution | 98.88 s | 99.72 s |
| Process user CPU time | 144.24 s | 136.29 s |
| Maximum overlapping test files | 2 | 2 |

The observed wall reduction is 2.82 seconds (4.2%); environment setup fell 29.6%. Exact file paths and all 757 test names match between JSON inventories. One pair does not establish the distribution or a universal speedup. Aggregate phase times overlap and must not be added to wall time. Packaging still dominates the release critical path.

The original failed baseline remains recorded: a new runtime-input read using `new URL(asset, import.meta.url)` failed during Vite transformation. Replacing that read with `resolve(dirname(fileURLToPath(import.meta.url)), path)` fixed the import; its focused 11 tests passed before the valid pair. An initial treatment inherited `maxWorkers: 4` into each project, overriding the root CLI limit; its 38.63-second result had four overlapping files and is excluded. The final configuration shares only aliases and transforms. Installed Vitest 4's `resolveMaxWorkers` prioritizes project limits over root limits, so the worker cap must remain at the root.

Raw logs and JSON reports are ignored local evidence under `app/SiloUI/src-tauri/target/verification/frontend-perf/`. The accepted files are `baseline-fixed.{log,json}` and `treatment-fixed.{log,json}`; other samples are diagnostic only.

## Full-window profile

The initial profile showed the expensive application tests cover committed edits across pages, reduced-motion tooltips rendered through portals, global filtering, and preference persistence. Onboarding's slowest cases cover machine-capacity validation across the save-action boundary, custom memory values, and final machine order reflected in Review. These exercise shared state and production adapters. All 88 application and 48 onboarding tests remain at their existing seams; moving those assertions into isolated components would weaken the behavior under test.

Use `npm --prefix app/SiloUI test -- --project node` for the browser-free suite or the existing `test:watch` command with a file filter for the affected behavior. The normal `test` command still discovers both projects. Typecheck, lint, and a direct TypeScript check of `vitest.config.ts` passed.

Primary references: [Vitest test projects](https://vitest.dev/guide/projects) and [performance guidance](https://vitest.dev/guide/improving-performance). Configuration inheritance and worker precedence were also verified against the installed Vitest 4.1.11 types and `resolveMaxWorkers` implementation; current online documentation can describe a newer major version.

## Bounded CPU follow-up

After the native experiment released the CPU, profiled all 88 tests in `application-app.test.tsx` with one worker and Node's `--cpu-prof`. An ignored temporary config supplied `execArgv` directly to the DOM project, preserving every other setting. Passing `--execArgv` only at the CLI root did not produce a worker profile with these inline projects; that first run was diagnostic only. Both runs passed all 88 tests.

The profiled run took 36.88 seconds in Vitest, including 35.84 seconds executing tests, 72 ms setup, 487 ms imports and 398 ms environment initialization. The worker profile sampled 36.855 seconds of elapsed timeline; this includes idle samples and profiler overhead and is not an uninstrumented benchmark.

| Profile stack | Inclusive sampled time | Share of worker timeline |
| --- | ---: | ---: |
| jsdom `prepareComputedStyleDeclaration` | 20.618 s | 55.9% |
| jsdom `applyStyleSheetRules` | 20.575 s | 55.8% |
| jsdom stylesheet selector `matches` | 18.853 s | 51.2% |
| Testing Library role queries | 15.223 s | 41.3% |
| Accessible-name calculation | 14.290 s | 38.8% |
| user-event dispatch and descendants | 4.241 s | 11.5% |

These rows overlap: role queries compute accessible names, which inspect computed styles and match stylesheet selectors. Exclusive samples attribute 34.7% to jsdom, 22.3% to its DOM selector engine, 13.6% to React plus React DOM, and 0.4% to user-event itself. Idle accounts for 6.3%; garbage collection for 2.8%. This is style and selector work, not a browser layout measurement.

There is no demonstrated cheap setup/configuration waste left in this file. Setup and environment startup together account for under half a second. Real CSS affects collapsed-sidebar visibility and pointer interaction, and the suite explicitly checks tooltip and reduced-motion styling. Removing stylesheet processing, caching computed styles across mutations, disabling interaction checks, or substituting cheaper queries indiscriminately would weaken the tested behavior. Further work should reduce unnecessary query scope at proven component boundaries or minimize a reproducer for the upstream style/selector implementation, then benchmark that specific change. No such unmeasured test or dependency change was retained.

Local ignored evidence: `frontend-perf/cpu-profile/run-fixed.log`, `CPU.20260914.164040.27935.0.001.cpuprofile`, `summary.json`, and `hot-functions.json`. The temporary profiling configuration and sample-aggregation script are beside them. Analysis stopped within five minutes of the CPU handoff.
