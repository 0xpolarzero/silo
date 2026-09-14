# macOS title-bar alignment

The HTML toolbar is 44 logical pixels high, so its controls center at y=22.
Tauri's `trafficLightPosition.y` is not a button center: Tao and Wry set the
native title-bar container height to the close button height plus the inset,
while preserving each button's bottom-origin y coordinate.

The published application links macOS SDK 15.5. On the development Mac,
an isolated AppKit window with this SDK compatibility setting gives a button
frame height of 16 and origin y=6. The configured inset of 24 therefore places
its center at 26, four pixels below the HTML controls. A local SDK 26 build gives
height=14 and origin y=9, putting the same configuration at 22. Replacing 24
with 20 fixes the release geometry but breaks the newer SDK layout.

The native setup now measures each button's actual center in window coordinates
and adjusts its frame origin to center it at 22. It repeats after resize and
scale changes and leaves full-screen controls to macOS. Tao/Wry preserve the
adjusted origin when updating the container. Both HTML title bars must retain
44px height or update the native center constant alongside their height.

An isolated AppKit reproduction measured all three controls before and after
alignment at window widths 1160 and 900. SDK 15.5 compatibility: 26 → 22;
SDK 26: 22 → 22. The probe uses actual NSWindow/NSButton geometry, no account
or VM data. These measurements do not establish installed-app or update health.

Primary implementation references, inspected in the locked local crate sources:

- [Tao 0.35.3 native inset](https://github.com/tauri-apps/tao/blob/tao-v0.35.3/src/platform_impl/macos/view.rs)
- [Wry 0.55.1 native inset](https://github.com/tauri-apps/wry/blob/wry-v0.55.1/src/wkwebview/class/wry_web_view_parent.rs)

The exact reproduction is retained in the local verification session as
`/private/tmp/silo-titlebar-geometry.swift`; its legacy executable was linked
with SDK metadata 15.5 using `vtool`, then ad-hoc signed.
