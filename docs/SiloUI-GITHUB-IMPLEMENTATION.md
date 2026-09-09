# GitHub implementation plan

2026-09-09. User authorized implementation, parallel subagents/review, removal of
the POC/obsolete designs, and an **All repositories** option in Silo. This is the
single current plan. Legacy Swift/Python code is reference only.

## Behavior and scope

Connect in the browser through the Silo GitHub App, authorize selected/all GitHub
repositories, return to Silo, and choose selected/all repositories for each VM.
**All repositories** means all repositories the connected App/user can access,
including future authorized repositories, never arbitrary private repositories.
A successful connection enables GitHub access automatically; each VM still needs
a repository selection. Explicitly disabling access persists until another connection
or enable action. Default to read-only; **Allow GitHub changes** covers repository Git/API writes.
Selected mode retains per-repository write controls; all mode has an explicit
read-only default and an all-repository write choice. No unrelated UI changes.

Run standard Git/LFS/gh. GitHub-issued user tokens enforce selected repositories
and read/write groups per owner. No command allowlist, broad-token fallback or
GraphQL permission engine. Queries and mutations use their corresponding narrow
authority. The user accepts combined requests crossing credential boundaries can
fail; never automatically replay or split mutations after partial success.

## Native implementation

Silo connects directly to GitHub from its Rust backend. There is no hosted Silo
service, Node sidecar or token-bearing WebView request. The public native-client
App configuration includes a client ID and client secret; this is not a private
key. User access/refresh credentials remain in Keychain or Secret Service.

- `github.rs`: external-browser OAuth, S256 PKCE, random state, temporary loopback
  callback, secure account storage, real installation catalog, durable VM policy,
  truthful progress/error events and main-window-only mutations.
- `github_tokens.rs`: direct code exchange, refresh, restricted-token creation,
  individual-token retirement and whole-authorization revocation. Repository-only
  permission validation and read/write maps are explicit. Unknown grants fail.
- `github_http.rs`: fixed GitHub HTTPS destinations, no redirects, bounded response
  size/timeouts, redacted errors and retry gates. OAuth errors returned with HTTP
  200 fail. Empty HTTP 204 revocations succeed; already-absent 404 is idempotent.
- The existing MicroSandbox patch attaches only scoped credentials to the exact
  Authorization placeholder under verified TLS. It never substitutes the GitHub
  token into arbitrary bodies/query parameters or uses the parent token as a
  fallback. For opaque GraphQL IDs, bounded restricted read probes resolve the
  owner before forwarding the original request once.
- Existing guest Git/gh/LFS setup, selected/all controls and live Git/jj author
  updates remain. Guest packages come from signed Ubuntu repositories on initial
  provisioning; they are not yet baked into a shipped guest image.
- Explicit host Push transfers committed Git/LFS objects into isolated bundled
  host Git. Guest hooks/configuration and uncommitted files do not become host
  configuration or committed data. No guest write permission is temporarily added.

The hosted-service source, package, Docker image configuration and test harness
were removed. Its applicable request contracts now run as native tests. No UI
layout, labels or controls were changed in the server-free conversion.

## Live edits and failures

Repository choices save immediately. Additions and write enablement are combined
for 500 ms after the latest edit. Removals detach affected authority locally before
network work. Failed local updates remain errors rather than claiming removal.
Invalid remaining selections also detach old grants before reporting the error.

Only changed owner/read/write groups request new credentials. Unchanged scopes
reuse unexpired tokens. Superseded network results cannot attach to a newer policy.
Starting a VM and replacing its profile are ordered per VM. Applying a new profile
closes existing proxy connections without rebooting the VM. A read-token change
can briefly pause writes for the same owner while its paired profile is rebuilt.
Git identity changes do not request tokens or wait for GitHub. The repository
catalog refreshes every five minutes for all connected, enabled accounts, including
selected mode and accounts with no VM grants yet. Previously it refreshed only for
All repositories, leaving newly authorized repositories absent from the picker.

Confirmed rate limits honor Retry-After and exhausted x-ratelimit-reset with
exponential backoff and positive jitter. Automatic retries are bounded at five;
explicit Retry retains GitHub's imposed waiting period, including after relaunch.
Ambiguous code exchange, refresh or mint outcomes are not automatically replayed.
Safe reads and idempotent revocations can retry. Guest writes are never replayed.

When refresh succeeds but secure storage fails, the renewed credential is retained
in host memory for storage retry, tied to the original account token. The consumed
refresh token is not submitted again. Disconnect uses the renewed credential if
necessary. If the process dies before that credential can be saved, reconnect can
be required; no plaintext fallback is used.

Public snapshots never read Keychain/Secret Service. They use only a process-local
observation of credential expiry, absence or a safe error. The existing worker
performs secure-store operations and publishes changes; no token bytes enter that
observation. Initial permission waiting uses the existing unavailable notice and
disables retry. Routine reads retain previously verified unexpired state until a
result arrives. This prevents a Keychain permission dialog from freezing the entire
app's initial state load. A blocked-reader regression verifies the boundary.

The callback parser reads bounded complete headers across fragmented input and
ignores unrelated local traffic. Invalid authenticated responses, empty codes,
wrong state, duplicate codes and declined authorization cannot create a session.

## GitHub App and build configuration

Reuse **microsandbox-workspaces**, owned by **0xpolarzero**:

- App ID: `4605731`.
- Public client ID: `Iv23liEjp3VnGe0sw2LU`.
- Callback: `http://127.0.0.1/github/callback`, wildcard matching disabled.
- Device Flow disabled for the desktop PKCE flow.
- Expiring user tokens already enabled.
- Repository permissions only; organization/account permissions remain absent.

The callback and Device Flow changes were saved and verified in authenticated Zen
on 2026-09-09. The user generated the client secret; the native macOS build was
configured and real browser sign-in succeeded as the existing account. The value
was not committed or written to test output.
No private key is required and none must be bundled.

Release builds supply `SILO_GITHUB_CLIENT_ID`, `SILO_GITHUB_CLIENT_SECRET` and
`SILO_GITHUB_APP_SLUG` in their environment before invoking the normal desktop
build. These are native compile-time settings. `build.rs` tracks changes to them.
The client-secret value is extractable from a distributed native binary and is
not treated as a confidential security boundary. Do not commit actual values to
source or confuse them with users' bearer tokens. There is no service URL setting.

## Verification

Latest completed checks for the server-free conversion:

- `npm --prefix app/SiloUI test`: 484 passed across 52 files.
- `npm --prefix app/SiloUI run lint`: passed.
- `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --offline -- --test-threads=1`:
  198 passed, 4 ignored, including permission-denial and blocked-Keychain regressions.
  The final worker lock adjustment also passed all 34 focused GitHub tests.
- Direct native operations: 8 contract tests and 12 transport/retry tests,
  including actual private-loopback HTTP responses.
- The authenticated native harness and nested real-VM regression passed together
  in 68.91 seconds, then again in 71.02 seconds with stricter denial assertions.
  Three private synthetic fixtures were explicitly authorized for the existing App.
  No working repository was used for mutations.
- `npm --prefix app/SiloUI run desktop:build:debug`, with native App configuration:
  the ad-hoc signed macOS bundle built successfully and completed browser sign-in.
  Existing bundle-size and unused-function warnings remain; notarization was not
  requested.

The existing hardware regression previously passed through actual production
Start/Restart in 24.50 seconds using a synthetic rejected credential and removed
its own VM. The runtime patch has not changed during this conversion, so that is
retained evidence rather than a newly claimed hardware run. Patch SHA:
`e6868dfbef5e7800949adbad98bda7fa501e8df47ac7146e601b50f145349ee8`.

### Authenticated evidence and repeatable run

Follow `app/SiloUI/tests/live/README.md`. The native test uses actual production
operations against three explicit private fixtures: read A, write B, deny C.
It checks REST/GraphQL boundaries, node-ID mutations, child re-scoping/reset,
All repositories and individual-token revocation without losing the parent.
Optional VM execution tests real Git, gh, LFS bytes and live access changes using
only scoped credentials in the native child process.

Observed with real GitHub on 2026-09-09:

- Browser Connect/return completed and showed the real connected account.
- Final configured macOS bundle reopened normally with the real dev/playgrounds
  VMs running and personal stopped. GitHub showed Connected as @0xpolarzero;
  the personal repository picker listed all six authorized repositories, including
  the three new private fixtures. No sandbox grant was selected during UI checks.
  The app was left open on GitHub. The earlier instance was closed through its
  Quit menu and its process exit verified before relaunch.
- The prior rebuilt instance's loading stall was traced to Keychain with a brief
  process stack sample. The final build loaded normally; the deterministic blocked
  credential regression separately verifies pending authorization cannot block
  public snapshots. No system permission was bypassed.
- Read tokens accessed fixtures A/B and received explicit permission denial for C.
  Write tokens accessed B and were denied A/C. REST and GraphQL were checked,
  including opaque node IDs and unchanged issue data after denied writes.
- GitHub refused child-token minting with HTTP 401 and the exact message
  “A scoped token cannot create another scoped token.” Token reset did not expand
  access. Rate limits, transport failures and unknown responses were not proof.
- All-repositories tokens accessed all three authorized fixtures. Retiring one
  child left the parent and sibling usable. Every tracked test child was revoked.
- The actual VM cloned/fetched/pushed Git, used gh and round-tripped 1 MiB through
  Git LFS. Real bearer tokens were absent from guest environment/Git configuration.
  Write removal, full removal and restoration took effect with unchanged boot ID.
- Both passing runs removed their disposable VM and branch. Four marked test
  issues, including diagnostic runs, were closed; only the main branch remained.
  Private fixture repositories and uploaded LFS test objects remain for evidence.

The first run timed out and was not counted as success. Subsequent diagnostic
runs exposed incorrect test assumptions about GitHub's 403 repository denial and
401 scoped-parent refusal; predicates now require exact permission errors.

Browser cancellation, PKCE rejection, refresh rotation/storage failure and other
error handling have focused automated coverage; real expiry-driven refresh,
Host Push against GitHub and Linux hardware still need explicit live checks.

### Exact UI verification after App setup

1. Launch `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app` in normal mode.
2. Open GitHub and click Connect. Confirm Connecting feedback, authorize through
   GitHub in the external browser and return to the same app window.
3. Select repositories for a VM; toggle write permission, then switch to All
   repositories. Confirm persisted choices and real applying/success states.
4. Change access while the VM is running. Verify allowed and forbidden Git/gh
   requests and unchanged boot ID; do not infer success from a green card alone.
5. Reopen onboarding GitHub/review and confirm identical choices, completion and
   compact existing cards. Skipping GitHub must still permit setup completion.
6. Test cancellation, denied access, network failure and Retry. Inspect normal-size
   screenshots for unchanged layout and single-line normal captions.
7. Relaunch and verify saved account/policy restoration. Disconnect and verify both
   local access removal and GitHub revocation results without fabricated success.

## Sources and design evidence

The full rationale and hostile-case test matrix are in
`SiloUI-GITHUB-SERVER-FREE-RESEARCH.md`.

- [GitHub native-client best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).
- [GitHub's own distributed PKCE client](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md).
- [Scoped user-token API](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token).
- [OAuth and token revocation](https://docs.github.com/en/rest/apps/oauth-applications).
- [PKCE support](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/).
- [Rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).
- [Pinned MicroSandbox source](https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab).
- [Git LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md).

## Connection defaults and empty-policy regression (2026-09-09)

An empty native policy array incorrectly bypassed host-author defaults. Drafts now
resolve each VM independently: existing policy first, then the actual host Git/jj
author. No configured author means empty fields with identity application disabled;
repository access does not depend on inventing an author. Unfinished identity text
is preserved locally and is not submitted by unrelated repository changes.

A rejected configuration save now ends local applying feedback, preserves the
valid repository catalog, and lets the existing Retry action resubmit that intent.
Stale rejections cannot override newer edits; whole-configuration rejection settles
all outstanding local VM edits included in that request.

Validation: 492 frontend tests across 52 files, 35 focused native GitHub tests,
lint/type checking, and the configured macOS debug bundle passed. The real app
showed the host author populated for all three VMs. Its renewed Keychain approval
was still pending before the final reconnect/All repositories interaction check;
those interactions must not be claimed verified from this build yet.
