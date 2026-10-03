# Frontend startup bundle baseline, 2026-10-02

O-03 decision: keep the current bundle until a measured startup improvement
justifies a split. The size warning remains; this run establishes artifact size
and heavy modules, not slow startup.

## Measurement

Measured commit `c3b8b7f692ba7efa1b097926dfe47aaa378f549f` on Apple M4 Max,
64 GiB RAM, macOS 26.5 ARM64, Node 24.11.1, npm 11.14.1, Vite 8.2.2.
Dependencies used the required symlink to the main checkout's `node_modules`;
the lockfiles matched. Ran `npm --prefix app/SiloUI run build` with Node 24
on `PATH`. TypeScript and Vite passed; Vite transformed 2,198 modules and
reported 489 ms of build time. Build time is not application startup time.

| Production artifact | Bytes on disk | Vite-reported gzip, decimal kB |
| --- | ---: | ---: |
| `assets/index-xvldHYn6.js` | 1,074,745 | 311.62 |
| `assets/index-DBwuy4YI.css` | 96,164 | 16.23 |
| `index.html` | 538 | 0.33 |

The JS is one entry chunk with no static or dynamic chunk imports. Its SHA-256
is `1d988aa17e4fd547efa3eb720680e9aaff941d5188861d4b8c452b669e14ed38`.
Compared with the first review's rounded baseline, JS increased by 1.76 kB
minified and 0.26 kB reported gzip; CSS remains 96.16 kB.

A disposable `generateBundle` plugin inspected
[Rolldown's `renderedLength`](https://rolldown.rs/reference/Interface.RenderedModule).
These are tree-shaken module code lengths before whole-chunk minification,
not minified bytes, gzip shares, or predicted savings. The audit emitted
byte-identical JS to the ordinary build. Total rendered length: 2,189,879.

| Module group | Rendered length | Share |
| --- | ---: | ---: |
| Silo `src/` | 1,013,749 | 46.3% |
| `react-dom` | 459,887 | 21.0% |
| All `@radix-ui/*` packages | 268,045 | 12.2% |
| `zod` | 132,710 | 6.1% |
| `tailwind-merge` | 56,010 | 2.6% |
| `sonner` | 53,335 | 2.4% |
| `@tauri-apps/api` | 41,374 | 1.9% |
| `lucide-react` | 36,799 | 1.7% |

Largest individual modules: React DOM client (453,173),
`desktop/production-source.ts` (99,110), Tailwind Merge (56,010), Sonner
(53,335), Radix Select (43,061), Zod core schemas (42,108),
`features/application/pages/overview-page.tsx` (39,988), and
`computer-detail-page.tsx` (32,752). No `src/fixtures/` modules were emitted.

Reproduce the module inspection after the ordinary build, from `app/SiloUI`
with Node 24. This uses the repository's unchanged Vite production config and
an isolated ignored output directory, following the
[Vite build API](https://vite.dev/guide/api-javascript.html#build):

```sh
node --input-type=module <<'JS'
import { build } from 'vite'
await build({ build: { outDir: 'dist/o03-audit' }, plugins: [{
  name: 'measure-modules',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      console.log(chunk.fileName, chunk.imports, chunk.dynamicImports)
      console.table(Object.entries(chunk.modules)
        .map(([id, m]) => ({ id, renderedLength: m.renderedLength }))
        .sort((a, b) => b.renderedLength - a.renderedLength))
    }
  },
}] })
JS
```

Local untracked evidence under `app/SiloUI/`: `dist/o03-modules.json`,
`dist/o03-measure.mjs`, and `dist/o03-evidence/`. The evidence also preserves the failed
Homebrew Node attempt: its `node@24` link resolved to a broken Node 25 binary.
The successful run used the installed Node 24.11.1 from nvm. No native build,
app launch, live data, or VM was used.

Verification passed: the documented audit command reproduced byte-identical
JS, CSS, and HTML; relative file links in both edited documents resolved;
typecheck, Rust formatting, and `git diff --check` passed. Lint exited zero
with 12 existing warnings. This documentation-only change adds no behavior tests.

## Why no split

`src/main.tsx` eagerly imports the main surface and native viewer for all window
types. The viewer component itself contributes 15,711 rendered units (0.72%);
its embedded guest desktop client is outside this Vite bundle. Shared React,
UI primitives, and contract validation would remain needed. A viewer-only
split therefore has no demonstrated startup payoff.

The main surface also imports onboarding, status, and application UI.
`ApplicationApp` mounts GitHub, Secrets, and Settings content behind `hidden`
sections; wrapping those imports in lazy components alone would still request
them at startup. Changing their mount policy would require checking retained
drafts, subscriptions, and busy state. This is not an established low-risk
optimization. Arbitrary vendor chunks would not establish deferred work.

Cold main-window first paint/readiness, status-panel readiness, viewer shell
paint, and guest first frame remain unmeasured on supported minimum hardware.
The host above is not that hardware, and browser-only execution renders the
unavailable screen rather than these native flows. No startup latency claim
or changeset follows from this run.

Next action: record repeated cold startup timings for those three windows on
minimum supported macOS and Linux hardware, then compare one deferred boundary
against that baseline, including first-use latency and failure recovery.
