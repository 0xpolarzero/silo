# Codex Linux engine distribution and live probe, 2026-09-22

## Result

The Linux ARM64 engine is distributed and functionally usable through its
bundled JavaScript API. A controlled GTK/X11 smoke test passed on Ubuntu 24.04.
This is separate from official feature availability: the
[Linux desktop guide](https://learn.chatgpt.com/docs/linux/linux-app#compatibility-and-limitations)
still says Computer Use is not yet available in the Linux preview.

No Codex app sign-in, model call or account credentials were needed for this
direct local engine test. This does not establish that the full Codex plugin
can be enabled in the Linux app, nor that the engine is licensed for inclusion
in another distributed product.

## Where it is

Downloaded the official ARM64 Debian package linked by the Linux guide:

`https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_arm64.deb`

- Package: `chatgpt`, version `26.915.31945`, architecture `arm64`.
- Download: 395,992,614 bytes.
- Package SHA-256:
  `b94c494b5f0fd7c720fa6fccd5ef609879affc62332ca930ed29b907d537bc6d`.
- Runtime: `cua-node-0.0.16-20260915001755-492f19756c31-linux-arm64`,
  bundled Node `24.21.0`.
- Native engine in the package:
  `/usr/lib/chatgpt/resources/cua_node/lib/node_modules/@oai/sky/bin/linux/sky_linux_arm64`.
- Another engine copy exists under `@oai/cua/bin/linux/sky_linux_arm64`.
- Engine SHA-256 for the tested Sky copy:
  `e60f50bf7239963fac6d725a41044de04bc96c6eca224a5016880fa12fbb0f8c`.

The executable is dynamically linked AArch64 ELF. Its help exposes an
`x11-full-desktop` client, a persistent `server` command, observation, window
discovery, accessibility actions, mouse input and text/keyboard operations.
No native Wayland backend was demonstrated. The public npm endpoint for
`@oai/sky/latest` returned HTTP 404; the verified distribution route is the
desktop package, not a public npm install.

The downloaded package and extracted runtime were retained temporarily under
`/private/tmp/silo-cua-engine.yy0cvD/`. Nothing was installed into the host app.

## Live verification

Used the already-running ARM64 Docker engine and a new disposable `ubuntu:24.04`
container named `silo-cua-probe-yy0cvd`. Mounted only the downloaded runtime
read-only, without host credentials, host desktop access or published ports.
Installed Xvfb, Openbox, D-Bus, GTK3/Python, AT-SPI and X11 libraries inside it.
The initial executable check reported missing `libX11.so.6` on the bare base
image; after dependency installation, the engine started normally.

The test imported the shipped `@oai/sky` JavaScript entry point with bundled
Node and operated a real GTK3 fixture named `Silo CUA Engine Probe`:

1. Discovered its window through `list_windows()`.
2. Captured its screenshot and accessibility tree through `get_window_state()`;
   the reported tree source was `at_spi`.
3. Located the accessible `Probe text` field and typed `Café 日本語` by element ID.
4. Observed the resulting text value and located the `Save probe` button.
5. Clicked that button by element ID.
6. Independently read the fixture's output file and asserted exact Unicode
   equality with the requested string.
7. Captured the final screenshot and observed the changed Saved label.

The script exited 0. Final screenshot: JPEG, 480 × 180, 11,036 bytes. The minimal
container lacked Japanese fonts, so those glyphs rendered as boxes; accessibility
and file contents preserved the exact Japanese text. This is a real GUI/API
integration check, not a mocked engine result or a model-led task benchmark.

Preserved source probes, before/after screenshots, exact output text and package
file inventory in the ignored directory:

`app/SiloUI/src-tauri/target/verification/codex-linux-engine-2026-09-22/`

`session.sh` starts the isolated display and fixture;
`probe.mjs` performs the API assertions; `fixture.py` supplies the GTK controls
and independent saved-file behavior. The downloaded runtime was mounted at
`/opt/cua`; test scripts were copied to `/tmp` inside the container and run with
`dbus-run-session -- sh /tmp/session.sh`.

After copying the evidence, verified the container's ID and research label,
stopped and removed it, and confirmed that the filtered container listing was
empty. Existing containers and the user's desktops were not changed.

## Meaning for Luda

The premise that no usable Linux engine is available is disproved for this
ARM64/X11 configuration. Technical availability does not establish permission to
ship it in Luda or Silo; see the redistribution findings below. Remaining
technical questions include packaging/dependency support, integration with the
desired agent clients, and performance across real applications. This probe does
not qualify x86-64, Wayland, human coexistence, failure recovery, Silo VM
integration or the full native Codex experience.

## Redistribution findings, 2026-09-22

The published [OpenAI Service Terms, section 10](https://openai.com/policies/service-terms/#10-licensed-materials)
prohibit modifying, redistributing or sublicensing Licensed Materials. Section
10(b) limits use to use with or connection to OpenAI Services. A component's own
open-source license can override those restrictions for that component. A
separate agreement could also change the applicable rights.

Package evidence:

- The Debian package's `/usr/share/doc/chatgpt/copyright` contains an MIT notice
  identifying Electron contributors and GitHub. It does not name Sky or CUA.
- `cua_node/LICENSE` identifies Node.js and third-party components; its MIT
  notice is not an express grant for OpenAI's engine.
- The inspected `@oai/sky`, `@oai/cua` and `@oai/cua-repl` package manifests
  contain no license field. The Linux unified plugin manifest contains none
  either. No component-specific open-source grant for the engine was found.
- The older installed macOS `computer-use/1.0.1001103` plugin manifest explicitly
  labels that plugin `Proprietary`; this is separate evidence, not a license
  field found in the Linux plugin.

Consequently, do not treat the successful probe as clearance to distribute the
engine. Bundling it in an installer or guest image needs a licensing basis that
this research did not find. Referencing a user-installed copy avoids shipping
that copy, but does not resolve the scope-of-use condition. Obtain written
permission for the intended integration before making this a distributed Luda
or Silo dependency.

## Dependency license check, 2026-09-22

This targeted check found copyleft dependencies, but did not establish a license
violation or certify the package's compliance. Evidence is saved alongside the
probe as `dependency-license-check.json`.

- `sharp` 0.35.4 and its ARM64 addon declare Apache-2.0; Playwright 1.57.0
  also declares Apache-2.0.
- `@img/sharp-libvips-linux-arm64` 1.3.3 declares LGPL-3.0-or-later. Its README
  identifies libvips, GLib, librsvg and other dependencies as used under LGPLv3.
  The upstream libvips project itself identifies its license as
  [LGPL-2.1-or-later](https://www.libvips.org/); the bundle explicitly exercises
  the later-version option.
- `objdump -p` confirms the sharp addon dynamically depends on the separately
  shipped `libvips-cpp.so.8.18.6`. This supports a shared-library arrangement;
  it does not prove that replacing the library works in the complete app.
- The Sky executable's direct ELF dependencies are `libX11.so.6`,
  `libgcc_s.so.1`, `libpthread.so.0`, `libm.so.6`, `libdl.so.2`, and `libc.so.6`.
  Embedded Rust paths identified 35 crate/version hints, not a complete SBOM.
  Dynamic headers do not reveal all statically included or runtime-loaded code.

[LGPLv3 section 4](https://spdx.org/licenses/LGPL-3.0-only.html) permits a
proprietary application under conditions, including notices, license copies,
library replacement/relinking and permission to debug library modifications.
Distributing the library also entails corresponding-source obligations under
the incorporated GPLv3. This check did not establish the complete source
provision, notice coverage or replacement behavior for this package.

[GPLv3 sections 5–6](https://spdx.org/licenses/GPL-3.0-only.html) would impose
broader requirements on a covered combined work, subject to applicable
exceptions or separate permissions; merely packaging independent programs
together does not make them one GPL work. No specific dependency establishing
that Sky itself must be distributed under GPL was identified in this check.

OpenAI's section 10 expressly preserves additional component-specific
open-source rights. Such an exception addresses contractual restrictions but
does not itself prove fulfillment of source and notice obligations. A suspected
violation is not a sufficient basis for redistributing the proprietary engine.
The next evidence needed for a full audit is the complete dependency inventory,
applicable licenses/exceptions, and corresponding-source provision for the exact
shipped builds.
