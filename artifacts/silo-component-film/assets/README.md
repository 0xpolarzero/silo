# Computer-use cursor

`codex-agent-cursor.png` is the original browser agent cursor artwork from the
locally installed official Codex application, reused at the user's request.
It is 46×48 pixels. SHA-256:
`c575bc277bab1b09518433aa465be98a8c04b305fe78ed674bf016bfa350e491`.

Read-only source inspection on 2026-09-27:

- Installed app: `/Applications/ChatGPT.app`, bundle `com.openai.codex`, version
  `26.924.22138`, build `11645`.
- In `Contents/Resources/app.asar`, member
  `webview/assets/options-menu-view-3b453ae3aeba.js` embeds the PNG as `Ci` and
  exports it as `z`. The cursor controller creates `browser-agent-cursor` and
  `data-browser-agent-cursor-asset` elements.
- `webview/assets/page-70bf3c972c7f.js` imports that export as `Et` and passes it
  to the browser-use cursor controller. `tab-content-3810ebad23ce.js` does the
  same with `_a`, using `var(--app-color-accent-blue)` for the glow.
- The renderer displays the asset at 23×24 in a 24×24 wrapper, with a 12,12
  rotation origin, an inner translation of 12,−2.5, an image rotation of 44°,
  and a resting wrapper rotation of −44°. The glow uses 6 px at 90% and 15 px
  at 48%. The installed CSS resolves accent blue to `#339cff`.

The film retains that artwork, alignment and glow. Its movement and click
compression follow the film's deterministic timeline, at 1.8× visual scale;
they do not execute or claim to reproduce the live controller's spring physics.
The ordinary human cursor remains separate. No installed application or LCU
runtime was modified, and no runtime implementation was copied into the film.
This third-party asset is not relicensed by Silo or LCU.
