# Silo landing page reference

Research and implementation date: 2026-09-18.

## Approved direction

The user selected [Zed](https://zed.dev/) as the sole reference: "It's just exactly
what we want to copy." OrbStack and CleanShot were rejected as references for
the implementation. The site follows Zed's light canvas, fine boundary lines,
small grid intersections, logo-orange accent, italic serif hero, compact
buttons, three-column introduction, product preview, and workflow tabs.

The branding, copy, geometric illustration, and product media belong to Silo.
There are no invented customer endorsements or unsupported performance claims.

## Primary sources

- [Zed homepage](https://zed.dev/): inspected live screenshots, accessibility
  tree, and rendered typography. Its hero uses IBM Plex Serif at 48px; the
  site combines serif headings with compact body text and a fine border grid.
- [Zed downloads](https://zed.dev/download): platform and architecture choices
  with requirements and release context. Silo exposes macOS and Linux together.
- [IBM Plex](https://github.com/IBM/plex): open-source type family. The website
  self-hosts the Google Fonts Latin WOFF2 builds of Plex Sans, Serif, and Mono
  with their SIL Open Font License. Zed's custom body font is not copied.
- [Silo release v0.6.3](https://github.com/0xpolarzero/silo/releases/tag/v0.6.3):
  GitHub's public release API confirmed all five advertised asset names:
  macOS ARM64 DMG, Linux x64/ARM64 .deb, and Linux x64/ARM64 AppImage.

## Product evidence

The repository README describes local and remote Linux development VMs, editor
and terminal handoff, development-server connections, scoped GitHub access,
secrets, and backups. The download area includes the Apple Silicon/macOS 14+
requirement, Ubuntu 24.04 compatibility, Linux KVM requirement, and macOS
first-launch instructions for an app that is not notarized.

The existing `demo/out/silo-demo-v11.mp4` supplies the 47.5-second tour and still
frames. Its production components use sample data and inert backend actions;
editor, agent, terminal, hardware, and notification views are illustrations.
The page identifies the media as a demo and provides descriptive captions and
a transcript. No native app or live VM was launched to build the site.

## Implementation

The website lives in `website/`, independently of the native app and the demo
project. It is a static Vite build with no runtime framework, backend, account
system, or analytics. The local preview uses port 4173. No site was published.

The page provides a hero, three product principles, a product tour, selectable
computer/tool/network workflows, GitHub/secrets/backup demonstrations, downloads,
and short setup FAQs. It supports keyboard navigation, reduced motion, native
video controls, a focus-managed dialog, and explicit Linux architecture choices.

Acceptance target: a visitor can identify what Silo does, see the main workflow,
and find a compatible download without opening documentation. Browser validation
covered desktop and mobile presentation and the principal interactions; see
[website README](../website/README.md) for commands and verification limits.

The user subsequently selected the logo orange (`#ff9f0a`) as the website accent.
Buttons use that exact orange with dark labels; links and accent headings use
a darker orange (`#995700`) for contrast on the light canvas. Zed remains the
layout and typography reference.
