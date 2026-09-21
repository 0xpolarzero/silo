# Silo website

A static landing page for Silo, built with HTML, CSS, JavaScript, and Vite. The
approved reference is [Zed](https://zed.dev/). The site uses Silo's branding and
product demonstrations, self-hosted IBM Plex fonts, and direct release downloads.

## Run

Use Node.js 24. From the repository root:

```sh
npm --prefix app/SiloUI ci
npm --prefix website ci
npm --prefix website run dev
```

Preview: http://127.0.0.1:4173. This serves only the website, not the native app.

```sh
npm --prefix website run typecheck
npm --prefix website test
npm --prefix website run build
npm --prefix website run preview
```

Stop the development server before running the production preview, since both
use port 4173. Deploy `website/dist/` to a static host. No backend, environment
variables, account, cookies, or analytics are required by the site.

## Content and assets

- `index.html`: copy, semantic layout, download links, and video dialog. Inline
  first-paint rules constrain the logo and hide the skip link until focused,
  even before external CSS arrives; keep these sizes aligned with `src/style.css`.
- `src/style.css`: responsive layout and Zed-inspired typography/grid.
- `src/main.js`: accessible workflow tabs, Linux architecture selection, video
  chapter playback, and dialog cleanup.
- `src/downloads.js`: explicit Linux architecture-to-package mapping.
- `demo.html` and `src/demo/`: an isolated, lazy-loaded React iframe using the
  actual Silo sidebar, navigation history, and production pages. Sample files,
  logs, repositories, secrets, computers, and backups come from bundled fixtures.
  The overview includes local VMs and a VM on Office Mac with expandable local
  and network SSH access. The 680px embed fits both expanded sidebar groups.
  Sidebar navigation, collapse/hover transitions, the production command palette,
  SSH disclosures, sandbox action menus, and sample storage/history inspection
  work. Commands navigate pages and sandbox views; native action commands are
  omitted. The shared overview read-only mode disables mutations, clipboard
  actions, native launches, and reordering; other
  pages use a disabled fieldset and captured interaction events. Mutation adapters also reject
  calls. Preferences and integrations use memory-only fixture stores. No native
  application controller or live data source is created.
- `vite.config.ts`: builds both static HTML entries and resolves shared app
  components and one React runtime from `app/SiloUI`. Install both packages
  before building; the deployed output needs neither Node nor the app installed.
- `public/media/`: portable, versioned website assets. Six screenshot pairs show
  the production glass UI with the read-only demo fixtures. Unsuffixed PNGs are
  light; `-dark.png` variants are dark. Workflow captures are 1280 × 720;
  GitHub, secrets, and backup captures are 1280 × 800. `overview.png` supplies
  the computers screenshot. `silo-tour.mp4` and its `silo-tour.png` poster remain
  the original v11 tour, deliberately unchanged.
- `public/theme.js`: first-paint theme selection shared by the page and demo.
  The icon-only navbar selector defaults to System and follows live OS changes.
  Explicit choices persist in local storage; blocked storage still allows
  switching during the visit. Picture sources and the iframe follow the same
  choice. Only same-origin parent messages can update the embedded demo.
- `public/media/tour.vtt` and `tour-transcript.txt`: descriptions of the silent
  demo. Keep these and the chapter timestamps aligned when replacing the film.
- `public/fonts/`: self-hosted Latin WOFF2 IBM Plex Sans, Serif, and Mono under
  the included SIL Open Font License. Fallbacks cover other character ranges.
- `public/favicon.svg`: the existing Silo app icon from `assets/silo-logo.svg`.

The Silo views in the demo use production components with inert sample data.
Editor, agent client, terminal, hardware, and notification views are
illustrations. Playback never touches native APIs, credentials, or live VMs.

Download filenames were verified against public release v0.6.3 on 2026-09-18.
Links use GitHub's `releases/latest/download/` endpoint, so future releases must
retain these stable filenames. Both Linux .deb and AppImage links follow the
explicit architecture selector. A no-JavaScript fallback exposes ARM64 links.

## Verification

Verification includes TypeScript, the production build, two download mapping
tests, and interactive demo tests covering sidebar history, disabled actions,
fixture pages, and absence of live data requests. Browser checks covered the desktop layout and 320px, 390px, and 768px
widths, loaded media, anchor targets, keyboard tab navigation, chapter seeking,
video playback, Escape dismissal, focus restoration, architecture selection,
and macOS installation disclosure. No horizontal page overflow was found.
The interactive embed was also checked on desktop and at 390px and 320px,
including collapsed sidebar navigation and page overflow.
These checks validate website behavior and fixture presentation, not live VM
operation or native package installation.

See [design research](../docs/SiloUI-LANDING-REFERENCES.md) for the approved direction.

## Vercel publication

Production: https://silo-theta.vercel.app (also set as the GitHub repository website).

The Vercel `silo` project is connected to `0xpolarzero/silo`. Pushes and merges
to `main` trigger production deployments; other branches receive preview deployments.
The project settings use Node.js 24 and the repository root with:

- Install command: `npm --prefix app/SiloUI ci && npm --prefix website ci`
- Build command: `npm --prefix website run build`
- Output directory: `website/dist`

Both packages are required because the website imports shared app components.
These settings are saved in Vercel. Git deployment behavior follows Vercel's
[Git integration documentation](https://vercel.com/docs/git), checked on 2026-09-19.

For a manual deployment, build locally, package the static output, and publish
the linked `silo` project:

```sh
npm --prefix website run typecheck
npm --prefix website test
npm --prefix website run build:vercel
npx --yes vercel@59.16.0 deploy --prebuilt --prod --yes --cwd website
```

For a new checkout, first run `npx --yes vercel@59.16.0 link --yes --project silo --cwd website`.
The deployment uploads only compiled public assets from `.vercel/output/`.
Vercel project metadata and local environment files are ignored. No native
build inputs or local configuration are published by this prebuilt command.

This follows Vercel's [prebuilt deployment](https://vercel.com/docs/cli/deploy)
and [Build Output API v3](https://vercel.com/docs/build-output-api/configuration)
documentation, checked on 2026-09-18.

### Shared UI boundary

The demo directly imports `ApplicationShell`, `OverviewPage`, and the other
production page components from `app/SiloUI/src`. It has its own page composition
and read-only data adapters rather than mounting the native application entry
point. The demo opens Settings expanded and retains the production sidebar footer placement.
Its CSS adjusts the outer window sizing and makes the embed canvas transparent so
the showcase card’s computer-style wallpaper shows through the sidebar and title bar.
The same wallpaper extends behind the heading and caption;
sidebar icon positioning belongs to the shared `components/sidebar-shell.css`.
After the alignment fix, browser measurements found zero x/y/size difference
across all ten visible navigation icons when toggling sidebar collapse.

## Refresh screenshots

Copy `scripts/capture.html` to `website/capture.html`, start the website dev
server, and open `/capture.html` or `/capture.html?theme=dark`. The harness
imports the same production components and inert fixtures as the demo. It
shows the default glass material even when the capture host has reduced
transparency enabled; the shipped demo uses the website background instead, disables blur for reduced
transparency, and uses opaque surfaces for increased contrast.
Capture Overview, Overview with personal’s SSH disclosure expanded (tools),
and Network at 1280 × 720. Capture GitHub, Secrets, and Backup at 1280 × 800.
Click the empty title bar to clear hover styling before saving each PNG.
Remove the temporary root capture file afterward; it is not a build entry.

Theme verification covers System changes, explicit choices, persistence,
blocked storage, and synchronization between documents. Screenshot checks
use fixture data, not live VMs or credentials.
