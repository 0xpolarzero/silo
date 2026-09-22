# Glass material study

The native material correction below supersedes the original production implementation. The original implementation incorrectly shipped the study’s artificial wallpaper and ordinary blur; it did not implement desktop refraction. The browser study and its Linux measurements remain historical evidence only.

Browser-only design experiment, 2026-09-21. Run `npm --prefix app/SiloUI run dev -- --port 1421` and open `http://localhost:1421/glass.html`.

The separate HTML entry renders Silo's existing `FixtureApp` and applies scoped CSS. It is not imported by the production entry or included in the default Vite build. All sandbox data and actions are fixtures. No native bundle was built or inspected. This internal preview does not change shipped behavior and needs no release changeset.

## Design

Compare Current UI, Frosted, and Refractive. The experiment uses transparent navigation and full title-bar surfaces, the existing shell and selection corner radii, a teal mineral backdrop and a more opaque content surface. Added glass highlights, outlines and corner rounding were removed after visual feedback. Existing component borders, spacing and radii are preserved across all three modes except the divider beneath the sidebar logo and name, which is hidden in the glass modes with its bottom padding and margin reduced to 8px each to bring the menu 16px higher; only material and color treatment change. The full title bar, including command search, uses the glass material for a continuous top surface. The main content retains its more opaque material. Light/dark appearance, displacement strength and backdrop position are interactive. The backdrop is an in-page design prop, not a capture of the desktop wallpaper. Native window transparency is not implemented by this prototype.

The SVG combines seeded `feTurbulence`, smoothing, and `feDisplacementMap`; CSS applies it to backdrop pixels before a small blur. This is an artistic refraction approximation, not an optical simulation or an edge-normal thickness model. A strong noise field looks like uneven glass; keep the default subtle. Text itself is not filtered.

## Compatibility evidence

- [WebKit issue 245510](https://bugs.webkit.org/show_bug.cgi?id=245510), consulted 2026-09-21, remains NEW and documents missing SVG URL backdrop filters. Recent comments describe proposed implementations and rendering failures. Do not infer shipping macOS support from CSS syntax acceptance.
- [WebKit's Safari 18 article](https://webkit.org/blog/15443/news-from-wwdc24-webkit-in-safari-18-beta/) documents unprefixed ordinary backdrop-filter support; that does not establish SVG URL displacement support.

The experiment enables SVG displacement only for a Chromium user agent and exposes an explicit fallback checkbox. This is a conservative preview gate, not a rendering feature test. Other engines get frosted surfaces. A native implementation needs separate WKWebView verification, accessibility/contrast checks, performance measurements, and a decision about desktop versus in-app background sampling.

## Verification

`npm --prefix app/SiloUI run typecheck` and `npm --prefix app/SiloUI run lint`. Visually inspected in the Codex Chromium browser with fixture data, including light/dark appearance and material controls. This establishes the browser concept, not packaged native compatibility or live VM behavior.

The shared submenu guide offset from commit `135cd52` is inherited directly. Glass modes additionally draw the guide per unhighlighted row, omitting it at selected/hovered rows because translucent selection fills cannot cover the original continuous line. Collapsed navigation hides these segments.

Dark glass sidebar hover fills use 6% white instead of the opaque application grays; selection stays brighter at roughly 9% white and 12% on hover. These tokens are scoped to the preview sidebar.

Light glass follows the same state hierarchy: 25% white on hover, roughly 44% for selection, and 55% for a hovered selection.

## Linux rendering and memory check, 2026-09-21

Tested the current browser fixture bundle in actual WebKitGTK **2.52.6** on Ubuntu 24.04 ARM64 and x86-64 OrbStack VMs. This uses a GTK WebView harness, **not a rebuilt Silo native bundle**. No live VM operations or user app data were used. The in-page background is a design prop; desktop transparency is still untested.

Evidence and the runnable harness are under `app/SiloUI/src-tauri/target/verification/glass-linux/` (ignored). `check.py` launches a localhost static server, then fresh WebKit processes for each material, three repeats each at 1× and 2× scale. Each process renders at 1140×1000 logical pixels, warms up after load, and records three process-tree PSS samples before snapshotting. PSS avoids simply double-counting shared pages; it does not measure all GPU memory. The benchmark includes the GTK harness and preview chrome. x86-64 runs under emulation on this Mac, so absolute totals are not comparable across architectures or representative of Silo production memory.

Reproduction in the existing test VM (from the evidence directory):

```sh
xvfb-run -a -s '-screen 0 2400x2100x24' dbus-run-session -- python3 check.py
```

The test needed Ubuntu packages `python3-cairo` and `python3-gi-cairo` to save snapshots. The initial missing-Cairo failure is preserved in `initial-missing-cairo.stderr` for each architecture.

### Rendering result

- Fixture UI loads in light and dark appearances; Linux fonts and Ctrl shortcuts differ from the macOS preview.
- The preview correctly disables SVG displacement on WebKit and chooses its frosted fallback.
- **Neither CSS blur nor SVG displacement produced different pixels in the headless checkerboard probe.** The `none`, `blur(8px)` and `url(#warp)` snapshots are byte-identical on both architectures.
- An additional ARM64 probe requested ALWAYS acceleration with `LIBGL_ALWAYS_SOFTWARE=1` and `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Both WebKit snapshots and actual X11 test-window captures still showed identical probe pixels. This rules out relying on the snapshot API alone, but does not establish behavior on a working physical GPU/compositor.
- Therefore this run establishes layout/fallback rendering, **not visual parity or functioning frosted glass on a normal Linux desktop**. A physical-GPU Linux native-bundle check remains required. No renderer workaround was added to Silo.

### Memory result

Median process-tree PSS in MiB (three fresh runs; see JSON for samples):

| Architecture / scale | Current UI | Frosted | Refractive selection, using fallback |
| --- | ---: | ---: | ---: |
| ARM64 / 1× | 540.5 | 543.4 | 546.3 |
| ARM64 / 2× | 655.4 | 655.2 | 656.0 |
| x86-64 / 1× | 770.9 | 776.3 | 772.4 |
| x86-64 / 2× | 879.9 | 882.9 | 882.1 |

The median difference is roughly 0–6 MiB, smaller than some run-to-run variation. Since the probe shows the effects were not rendered, **these numbers must not be quoted as the cost of functioning glass**.

For budgeting only: the roughly 216×636 sidebar plus 1088×44 title bar require about 2.8 MiB for one RGBA8 surface at 2× scale (`area × scale² × 4 bytes`). One full 1088×680 window surface is about 11.3 MiB. Several intermediate/cached surfaces put a reasonable provisional budget at **10–40 MiB extra per window at 2×**, not a measured guarantee. SVG turbulence/displacement can need further intermediates; large windows, higher scale, driver allocations and buffering can exceed that. CPU/GPU time and battery impact also need measurement with actual rendering; opacity alone is not the same workload as blur or displacement.

Primary references:

- [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/): Linux uses system WebKitGTK, macOS uses WKWebView.
- [WebKit backdrop filters](https://webkit.org/blog/3632/introducing-backdrop-filters/): filtering requires extra rendering passes.
- [WebKitGTK acceleration policy](https://webkitgtk.org/reference/webkit2gtk/2.38.0/property.Settings.hardware-acceleration-policy.html): requesting acceleration has no effect when unsupported by the system.

Preview URLs now accept `material=original|frosted|glass` and `appearance=light|dark` for deterministic rendering comparisons.


## Original production implementation (superseded)

The main application shell now owns the static teal backdrop, frosted navigation and complete title bar, and 94% light / 98% dark content surfaces. It preserves the existing border widths and corner radii, removes the logo divider, tightens logo-to-menu spacing, and gives submenu guides equal clearance around selected or hovered rows. Native danger/warning navigation tones are preserved. Onboarding and the separate status window retain their existing surfaces.

The backdrop is painted within the app, not sampled from the desktop. Native SVG displacement is not enabled: ordinary prefixed/unprefixed backdrop blur is the supported implementation path, with translucent color fills remaining when the renderer skips filtering. The prior headless Linux limitations still apply. There are no continuously animated background layers.

System reduced-transparency or increased-contrast requests replace the material with opaque semantic surfaces and hide the backdrop. The local browser reports `prefers-reduced-transparency: reduce`, and the solid fallback was verified without changing the user's preference.

The fixture entry `glass.html?production=1&appearance=dark` (or `light`) renders the real production shell without the study controls or style wrapper. It is not part of the normal production entry.

Validation:

- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint`: passed.
- `npm --prefix app/SiloUI test -- src/features/application/components/application-sidebar.test.tsx src/features/application/application-app.test.tsx src/features/onboarding/components/onboarding-shell.test.tsx`: 112 tests passed across three files.
- `npm --prefix app/SiloUI run desktop:build:debug`: succeeded. Exact output: `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. Build log is private ignored evidence at `src-tauri/target/verification/glass-native-build.log`.
- Production component fixture screenshots in light and dark were reviewed using Linux WebKitGTK. Evidence: `src-tauri/target/verification/glass-production/linux/`. The browser's reduced-transparency fallback and collapsed sidebar were also visually checked.
- No packaged native UI was launched or inspected. The existing `/Applications/Silo.app/Contents/MacOS/silo-ui` process belongs to the user and was left running. A successful bundle build does not establish live VM health or hardware-rendered native glass parity.

Release note: `.changeset/glass-application-shell.md` (minor). No version bump or publication.


## Native material correction, 2026-09-22

The application no longer paints the prototype wallpaper. On macOS 26+, `window_material.rs` wraps the existing webview content in AppKit `NSGlassEffectView` using its Clear style. The native compositor owns the glass material; CSS does not capture or displace desktop pixels. The Tauri window and main webview background are transparent, with the approved tinted sidebar/title bar and more opaque content surfaces above the material. Status and Linux desktop viewer webviews do not receive the main-window transparent CSS marker.

macOS 14/15 use native Sidebar vibrancy instead, which is not the same refractive effect. Linux retains an opaque application background: no equivalent desktop refraction is implemented there. The website demonstration’s independent wallpaper remains a presentation prop. No screen capture permission or wallpaper capture is involved.

Primary API references checked against the local macOS 26 SDK:

- [Apple NSGlassEffectView](https://developer.apple.com/documentation/appkit/nsglasseffectview)
- [Apple contentView](https://developer.apple.com/documentation/appkit/nsglasseffectview/contentview): the webview belongs inside the glass view’s content, not an unrelated sibling above it.
- [Tauri window-vibrancy native implementation](https://github.com/tauri-apps/window-vibrancy/blob/dev/src/macos/liquid_glass.rs) provides prior art for the public AppKit integration.

Verification uses `src-tauri/examples/material_preview.rs`, a native window hosting production components with deterministic fixture data and no Silo services. Start the frontend on port 1422, then run `cargo run --manifest-path app/SiloUI/src-tauri/Cargo.toml --example material_preview`. It does not acquire Silo’s runtime lock or manage VMs.

Rust compilation and frontend typecheck/lint passed; all 112 focused application/sidebar/onboarding tests passed. The isolated fixture bundle at `src-tauri/target/verification/Silo Material Preview.app` was launched and its populated native window visually inspected on macOS 26.5. The system’s Reduce Transparency preference is enabled and was left unchanged. This proves native composition starts and the fixture renders, **not visible refraction with transparency enabled**. Full-effect visual verification, older macOS fallback execution, Linux native execution, and native GPU/memory measurements remain outstanding. The existing installed Silo and its VMs were not restarted.


### Reduced-transparency detection correction

The native preview did not apply the CSS media-query fallback despite the macOS preference being enabled. The app now also reads `NSWorkspace.accessibilityDisplayShouldReduceTransparency` and increased contrast directly, synchronizes them after page loads, and observes `NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification` for live updates. An explicit native class restores opaque theme surfaces and neutral navigation colors. The CSS media query remains useful in supporting browser previews. Dark-theme selector specificity was corrected so the fallback overrides the glass palette.

References: [Apple accessibility preference](https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayshouldreducetransparency), [Apple change notification](https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayoptionsdidchangenotification), [CSS media feature](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-transparency).

After rebuilding the isolated material preview, visually verified the neutral opaque dark sidebar, toolbar, and content with the existing macOS Reduce Transparency preference enabled. Rust check and fixture build passed. Live preference toggling was not exercised because the system preference was left unchanged.

The corrected actual app was built successfully with `npm --prefix app/SiloUI run desktop:build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'`. Output: `app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app`. This is an optimized local bundle; no updater artifacts or publication. It was not launched over the user’s running Silo instance. Private build log: `src-tauri/target/verification/native-glass-build.log`.
