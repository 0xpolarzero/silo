# Silo demo

A 35-second, 1920×1080, 30 fps Remotion product launch film. All app data is
simulated and all backend actions are inert.

The v10 cut pastes the copied computer address in one step. Its ending shows
automatic port discovery, forwarding and the initial browser page, then opens the VM repository from
the production Files page in Zed. The final view keeps the VM editor on the left
and the laptop browser on the right; the browser updates after the edit is saved.
The Files shot lasts 1.5 seconds, with less than half a second over Open in Zed. The network sequence shows the discovered row before any click and uses the production action tooltips. Plain neutral surroundings, direct cuts, and no audio track remain.

## Run

Use Node.js 24. From the repository root:

```sh
npm --prefix app/SiloUI ci
npm --prefix demo ci
npm --prefix demo start
```

Open http://localhost:3400 and select **SiloDemo**. Remotion supports playback,
frame-by-frame inspection, and arbitrary seeking.

```sh
npm --prefix demo run render
```

Output: `demo/out/silo-demo-v10.mp4`. The original 110-second export is preserved
at `demo/out/silo-demo.mp4` when already present. The first render downloads
Remotion's headless browser; restricted macOS hosts need permission to launch it
outside the sandbox.

## Implementation and fidelity

| Surface | Implementation |
| --- | --- |
| Silo shell, GitHub and repository picker, secret list and editor, backup progress/results, connection form, overview, remote settings, network, status panel | Imported production components with fixture data |
| Terminal, editor, browser, computer silhouettes, native notification chrome | Demo illustrations |

The secret and connection forms now use the production components. Frame-driven
adapters open the secret editor and fill the connection field through their DOM
handlers. The custom backup review is removed. Files uses the production WorkspacesPage, repository actions, and a fixture directory loader.
Repository popovers retain production markup and await layout before capture.

- `src/timeline.ts`: shot boundaries and fixture frame ranges.
- `src/fixtures.ts`: inert app data and actions.
- `src/product.tsx`, `src/preparation.tsx`: production components and recordings.
- `src/film.tsx`, `src/style.css`: composition and motion.
- `scripts/cues.mjs`: historical sound generator, unused.

## Verify

```sh
npm --prefix demo run typecheck
npm --prefix demo test
npm --prefix demo run stills
```

Timeline tests cover boundaries, action outcomes, and reverse seeking. Rendered
frames establish presentation against fixtures, not live VM, SSH, native
notification delivery, or release readiness. Production app behavior is unchanged.

## References

[Storyboard](../docs/SiloUI-DEMO-SCRIPT.md) ·
[Remote behavior](../docs/SiloUI-REMOTE-COMPUTERS.md) ·
[Remotion compositions](https://www.remotion.dev/docs/composition) ·
[Rendering](https://www.remotion.dev/docs/cli/render)

Remotion dependencies are pinned together to 4.0.521. See the
[Remotion license](https://www.remotion.dev/license) for distribution terms.
