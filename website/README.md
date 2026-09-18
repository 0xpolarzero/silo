# Silo website

A static landing page for Silo, built with HTML, CSS, JavaScript, and Vite. The
approved reference is [Zed](https://zed.dev/). The site uses Silo's branding and
product demonstrations, self-hosted IBM Plex fonts, and direct release downloads.

## Run

Use Node.js 24. From the repository root:

```sh
npm --prefix website ci
npm --prefix website run dev
```

Preview: http://127.0.0.1:4173. This serves only the website, not the native app.

```sh
npm --prefix website test
npm --prefix website run build
npm --prefix website run preview
```

Stop the development server before running the production preview, since both
use port 4173. Deploy `website/dist/` to a static host. No backend, environment
variables, account, cookies, or analytics are required. Deployment is not part
of this local implementation.

## Content and assets

- `index.html`: copy, semantic layout, download links, and video dialog.
- `src/style.css`: responsive layout and Zed-inspired typography/grid.
- `src/main.js`: accessible workflow tabs, Linux architecture selection, video
  chapter playback, and dialog cleanup.
- `src/downloads.js`: explicit Linux architecture-to-package mapping.
- `public/media/`: portable, versioned website assets. `silo-tour.mp4` is copied
  from `demo/out/silo-demo-v11.mp4`; still frames come from that same export.
  The hero uses 14.7s; GitHub 3s; secrets 7s; backup 9.3s; computers 18.8s;
  network 23.5s; tools 44.5s. The hero image is framed with CSS.
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

The initial implementation passed the production build and two download mapping
tests. Browser checks covered the desktop layout and 320px, 390px, and 768px
widths, loaded media, anchor targets, keyboard tab navigation, chapter seeking,
video playback, Escape dismissal, focus restoration, architecture selection,
and macOS installation disclosure. No horizontal page overflow was found.
These checks validate website behavior and fixture presentation, not live VM
operation or native package installation.

See [design research](../docs/SiloUI-LANDING-REFERENCES.md) for the approved direction.
