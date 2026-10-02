# Tauri configuration micro-review

Scope: `app/SiloUI/src-tauri/tauri*.conf.json`, `capabilities/`, `Cargo.toml` features, `Info.plist`, and `Entitlements.plist`. Focus: excessive permissions, CSP, and updater configuration.

No defects found.

Evidence checked:

- `tauri.conf.json:45–53` selects four explicit capabilities and restricts production scripts to self. The development CSP adds inline scripts and the Vite localhost WebSocket. No remote capability URLs or broad filesystem, shell, opener, or updater-plugin permissions are granted in the selected capability files.
- `capabilities/desktop-viewer.json:5–8` grants permissions by shell webview label with an empty window list. Shell labels use `desktop-shell-` (`src/desktop_viewer.rs:209`); guest labels use `guest-` and guest navigation is restricted to its proxy origin (`src/desktop_viewer.rs:575–576`). The locked Tauri 2.11.5 authority checks both origin and matching window/webview labels; cached tauri-utils 2.9.3 documents that window grants cover child webviews, explaining why the empty window list matters here.
- `capabilities/application-events.json:5–6` grants listen/unlisten to main and status. The desktop shell polls state rather than subscribing to application events (`src/desktop/linux-desktop-viewer.tsx:115–130`). `capabilities/status.json:6` omits settings mutation permissions, and `src/settings.rs:772–778` removes onboarding drafts from non-main reads.
- `tauri.conf.json:98–102` configures an HTTPS updater endpoint and public signature key. The vendored updater's insecure transport and invalid-certificate/hostname options default to false (`vendor/tauri-plugin-updater/src/config.rs:129–134`). Although Dev inherits the endpoint, `src/updates.rs:211` disables automatic checks and `src/updates.rs:350–356` returns before the updater request.
- `tauri.macos.conf.json:5` selects the entitlement file. `Entitlements.plist:5–8` contains hypervisor and Apple Events permissions; it contains no library-validation, unsigned-code, debugger, or sandbox-wide file-access exception. `Info.plist:4–5` declares the Apple Events usage description. Cached tauri-utils 2.9.3 defaults hardened runtime to true and automatically merges adjacent `Info.plist`; `tauri.dev.conf.json:42` explicitly disables hardened runtime for Dev. The custom signing policy is separate and was inspected for context, not audited as part of this scope.

Prior findings were checked in the first review, pass 2, and local pass 3 reports. This was a read-only source review using file reads and searches. No build, test, native app, or live VM was run; packaged entitlements, CSP enforcement, and updater installation were not verified at runtime. Only this report was written.
