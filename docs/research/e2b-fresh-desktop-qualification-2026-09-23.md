# Fresh E2B desktop and synthetic Git qualification

Date: 2026-09-23. Candidate: pinned Embed Compose deployment in the owned
`silo-e2b-diagnostic-d1` Lima VM on an M4 Max. The full ARM64 desktop template
was built in that VM: template ID `8qq2o914wv20ma5spotb`, build
`679854f6-da01-4fb3-a3c6-ea92eb264fd8`, alias `silo-arm-desktop-lcu`.
The private build log SHA-256 is
`d6b47d1773b1d9ef4223c191aea9502de9225d4e3b8cfaf809c2e2be0d0db0d3`.
The historical `silo-e2b-poc` VM was not changed. This is a fresh control and
workflow run, not a reproduction or repair of D1–D3.

## One identified run

Run `10e614d143da4ed29187a63c922d970a` created two desktops and one
checkpoint fork. Its fresh `qualification.json` has status `passed`, with six
passing cases: kernel/guest isolation and selected private egress; LCU desktop
handoff, reconnect and Firefox; SDK PTY resize, Unicode, signal and exit; SSH
binary data, SFTP, EOF, exit status and revocation; and checkpoint fork/revert
with process-memory, disk and identity checks. The report SHA-256 is
`ed558a47bbc3385d2cc77004da159049dc0d801e1e42b6e799b29d42516c4ef3`.
The private run log SHA-256 is
`d26533685f8a0aedc5f93f260065a9c7523eb24573e423344b37a99eb0d6949c`.

The same run's `credentials.json` has status `passed`, with three synthetic
fixture cases: Bearer/Git Basic substitution and denied controls; real guest
Git smart HTTP push/clone and LFS blob upload/download through a local TLS
broker; and rotation, revocation, guest-home scan and checkpoint replay. Its
SHA-256 is
`2555a57a702597dcaf6853dceeaabf46049940b74bf0b6822683b6c541599558`.
The replay check accepts either transport failure or a 403 after restore. It
does not establish a usable new authorized request after restoring the old
checkpoint. The fixture used synthetic tokens and local repositories only;
there was no real GitHub account or grant.

The separate loopback viewer route returned 200 for the scoped workspace's
noVNC asset, 403 for a second workspace, and 404 for control APIs on the viewer
origin and viewer assets on the control origin. The probe report SHA-256 is
`155a3be400f0ba3c264310395b174b66539d7c1e365ee2ec3c03f1f126bd7bd6`.
The Codex browser rendered the live desktop and Firefox page. A disposable
AppKit/WKWebView window also rendered the Xfce desktop, Firefox and Mousepad;
native automation visibly typed into Mousepad. Direct automated Control chords
did not select or save as expected. Later attempts at the guest save dialog did
not provide a persisted-file oracle before the credential test reverted that
desktop. **Native file save is unverified in this fresh run.** The 2026-09-22
historical native save remains a separate observation, not an inherited pass.
The native harness was not packaged Tauri, and physical keyboard, clipboard,
two-viewer ownership and other input cases remain open.

The three logical desktops were deleted only after both reports were saved.
The exact-run cleanup receipt SHA-256 is
`469436eb408b91268ed4dbb3149419dcb266b8c986002d5d6d4403de08d03111`.
No active desktop from this run remains. The temporary native process, ticket
files, browser tab and port-13802 SSH forward were closed; the owned diagnostic
VM and its evidence were retained. Raw reports and private logs are under
ignored `app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/runs/10e614d143da4ed29187a63c922d970a/`.

At the post-cleanup read, macOS Data reported 18 GiB available; the Linux guest
filesystem reported 34 GiB available of 77 GiB, 5.1 GiB available RAM of
15.9 GiB, and 4,083 free 2-MiB hugepages. These are one-time observations, not
a capacity limit or retention policy. Further full-template builds on this
scratch host were stopped to preserve headroom. The ordinary desktop host-stop
path remains disabled pending a proven per-snapshot durability barrier.

## Second run: current grant after restore and native input

After macOS Data space increased, run `7d468e5fb97f450abcc4aba0707518b3`
repeated the same six desktop cases and three synthetic Git cases on the pinned
scratch deployment. The reports passed: `qualification.json` SHA-256
`9bbc0f080d317d7bf5eaf47c4b83ff2109cd3792121d4aa43b00ff20fe5e6082` and
`credentials.json` SHA-256
`c9c8fe4b59e137e8e6948214a7d6579bcb3c3c8496249697134020cde4381e50`.
The strengthened replay case reverted an older checkpoint, observed no new
upstream receipt from the revoked old grant, issued a new current grant, and
completed an allowed request whose upstream receipt matched the new token hash.
A denied other-repository request produced no upstream receipt. The fixtures
used local repositories and synthetic grants; live GitHub, `gh`, and GraphQL
remain untested.

The disposable WKWebView harness displayed Mousepad and native automation
inserted text into its buffer. Direct `ctrl+s` and `super+s` each inserted a
literal `s`; native clicks moved the pointer over Mousepad's File/Edit menus
without opening either. A separate browser viewer used File > Save. Independent
guest readback then found exact bytes `20 6e 61 74 69 76 65 2d 61 66 74 65
72 5a 51 73 73 6e 61 74 69 76 65 2d 62 65 66 6f 72 65 0a` and SHA-256
`8c6be973c8294a9fd2c749e0aa19302d0940a5150a2cb202b9e52b051126f575`.
This proves text entered through the native viewer reached the editor and could
be saved through the browser. It does not prove native click or save. The
[viewer input note](e2b-viewer-input-readiness-2026-09-23.md) gives a
falsifiable event-path diagnosis without assigning blame to WKWebView or noVNC.

A second browser viewer connected while the native viewer was in human mode.
Its `B` keystroke appeared in the same unsaved Mousepad buffer in both viewers.
Two session mint requests returned the same ticket digest
`bdd836e8baefd0a27a688ad6b83266602416304dbab21691b832ba69f2fde09e`.
The current PoC therefore does not provide exclusive one-viewer control. This
is PoC session policy, not an E2B runtime finding. Automatic browser review
rejected a separate test that changed an observer URL's `view_only` parameter;
that test was not retried, so server-enforced observer input denial remains
unmeasured.

The three exact run-owned desktops were deleted after reports and readback were
saved. Cleanup receipt SHA-256 is
`81756be10d500d23160967660d0ed6d21ffc383ed2868e71f3168ab0628fb0bd`.
No active desktop from this run remains. The temporary native process, browser
tabs, ticket files and port-13802 SSH forward were closed. Private evidence is
under ignored `app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/runs/7d468e5fb97f450abcc4aba0707518b3/`;
`native-viewer-followup.json` SHA-256 is
`8bc6f9372fc50c473c79e30fae9119d6c3c8d08fcda2c72f194247b32cac874e`.
An earlier launch with a precreated run directory failed before creating any
desktop; its raw log was retained separately. Mac Data showed 95 GiB available
after this run's cleanup, a point-in-time reading.

## Updated PoC integration regression

After the viewer ownership change, run `9a30a6e2362f478b9eaf1564b2447fb5`
stopped during the LCU case: the fixture wait returned when its Target window
appeared, then a lookup for the Other window raised `StopIteration`. Both
windows were present on later direct LCU inspection, establishing a test timing
race rather than a missing guest application. The failed `qualification.json`
was preserved before retry. The wait now requires both windows; failure
reports also include the exception type. Its two exact run-owned desktops
were deleted after inspection; cleanup receipt SHA-256
`0a7c56c93ec49bd89ae2ef64f9ee61a612f4544aab154081affe3a63d1fd96aa`.

Fresh run `afe75b686e9a47c19e2b83e5c47d30fd` then passed all six desktop
cases and all three synthetic Git cases against the updated PoC. Its
`qualification.json` SHA-256 is
`d20e173894957db243b031af0570a3fbfe28119543a2e0ed3ae859e8dfc6ca26`;
`credentials.json` SHA-256 is
`eaf0dd8c1d1be176b00909765f1f034bd1582eeac7b2814fa8f9464f0d8f4f68`.
The credential replay again confirmed that a current grant works after old
checkpoint restore. The local evidence endpoint returned nine checks,
`local_case_status=passed`, and overall `status=blocked`. The three exact
run-owned desktops were deleted; cleanup receipt SHA-256 is
`b81239406f115b2dc6317e206ced2822d243c188852523a35514cb258c001e7c`.
Private reports are under the corresponding ignored `evidence/runs/<run_id>/`
directories. This regression run does not include a packaged native viewer or
an upstream incident reproduction.

## Verdict

The passing runs close the fresh local workflow and synthetic current-grant restore
cases for the pinned scratch candidate.
It does not close incident provenance or D1–D3 failure handling, the real
provider/gh cases, native pointer/modifier input and save, exclusive viewer
ownership, packaged viewer input, tested storage retention, a full desktop host
restart, or two-computer/platform qualification.
The PoC and Silo cutover remain blocked on those explicit gates.
