# Luda 0.3.4 upgrade verification

Silo's optional Linux desktop recipe now pins [Luda 0.3.4](https://github.com/0xpolarzero/luda/releases/tag/v0.3.4), including the exact accepted skill from the [benchmark iteration](SiloUI-LUDA-SKILL-BENCHMARK.md).

## Pinned inputs

- Commit: `e3863fb24dd28bda5910a8c2382a13afd4ee1064`, verified against the release tag.
- [GitHub commit archive](https://codeload.github.com/0xpolarzero/luda/tar.gz/e3863fb24dd28bda5910a8c2382a13afd4ee1064) SHA-256: `a82772fb19db389260b5970d5657da6955700f36450b2da9dec6ea0c91bc0e15`.
- Entry skill SHA-256: `e90eae580e187882b7d6308eb35c77ff19a5a483857a5a0202a52ca7d6f88260`.

The downloaded commit archive passed Silo's extraction constraints. Its installer and all seven skill reference files match the previous source byte-for-byte. Its entry skill matches the accepted 1,999-word artifact exactly. The commit archive is the input consumed by Silo's installer; its checksum is specific to that archive.

The upgrade changes the release lock and installer version guard. The existing repair regression now uses the actual 0.3.3 predecessor. A patch changeset describes the user-visible update. Luda's tool semantics and Silo's registration strategy are unchanged.

## Automated verification

All 39 guest-script tests passed: 11 Luda setup, two desktop recipe, and 26 desktop service tests. Seven native desktop tests passed using the release guide's synthetic GitHub configuration. The synthetic test executable is not a distributable application.

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_luda_setup.py'
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_desktop_recipe.py'
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_desktop_service.py'
SILO_GITHUB_APP_SLUG=silo-unit-test SILO_GITHUB_CLIENT_ID=synthetic-unit-client SILO_GITHUB_CLIENT_SECRET=synthetic-unit-secret cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml desktop::tests --quiet
```

## Live upgrade

A disposable ARM64 Ubuntu 24.04 VM used an isolated `MSB_HOME`, the bundled guest image, the required `silo` working account, and this existing runtime executable:

```text
/Users/polarzero/code/projects/microsandbox-workspaces/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb
```

The test installed the previous 0.3.3 recipe first and independently confirmed `ludaState=ready`, `ludaVersion=0.3.3`. It then staged the updated source recipes and invoked `setup-desktop.sh setup-tools`, the same repair path used by Silo. The resulting status and installed Python package both report 0.3.4.

Verified after upgrade:

- All seven client MCP registrations remain present, owned by `silo`, and point to the session launcher under `/opt/luda/current`.
- Both installed skill trees contain all eight expected files, with exact upstream hashes and `silo` ownership.
- An unrelated Cursor configuration field survives the upgrade.
- An ordinary setup retry leaves ready-state metadata unchanged, confirming the matching runtime takes the idempotent path.
- A real stdio MCP client connects to 36 tools, checks desktop health, captures the screen, opens Mousepad, types and reads back `Café 日本語`, saves through Ctrl+S, and verifies exact file contents independently. The final screenshot shows the saved document.

This was a programmatic MCP integration check, not another fresh-agent benchmark. The exact skill is unchanged from the accepted benchmark, and this task did not rerun that suite or the packaged Silo UI. It does not establish x86-64 behavior or each agent application's approval/discovery UI.

The disposable VM was stopped and deleted, its absence verified with `msb inspect`, and its isolated runtime removed. No agent credentials were copied. User VMs and the running Silo app were untouched.

Evidence is retained under `app/SiloUI/src-tauri/target/verification/luda-034-upgrade/`, including the source archive, test log, before/after guest status, registration/hash checks, MCP transcript, screenshot, and cleanup record.

## Delivery

The updated recipe is bundled when Silo is built; no separate base guest-image release is required. Existing desktops receive the update through **Set up agent tools** or **Repair agent tools** in an updated Silo build, followed by agent reconnection. This task updates repository inputs and release notes; it does not publish a Silo release or replace the user's installed application.
