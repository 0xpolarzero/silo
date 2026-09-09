# GitHub implementation plan

2026-09-09. User authorized implementation, parallel subagents/review, removal of
the POC/obsolete designs, and an **All repositories** option in Silo. This is the
single current plan. Legacy Swift/Python code is reference only.

## Behavior and scope

Connect in the browser through the Silo GitHub App, authorize selected/all GitHub
repositories, return to Silo, and choose selected/all repositories for each VM.
**All repositories** means all repositories the connected App/user can access,
including future authorized repositories, never arbitrary private repositories.
Default to read-only; **Allow GitHub changes** covers repository Git/API writes.
Selected mode retains per-repository write controls; all mode has an explicit
read-only default and an all-repository write choice. No unrelated UI changes.

Run standard Git/LFS/gh. GitHub-issued user tokens enforce selected repositories
and read/write groups per owner. No command allowlist, broad-token fallback or
GraphQL permission engine. Queries and mutations use their corresponding narrow
authority. The user accepts combined requests crossing credential boundaries can
fail; never automatically replay or split mutations after partial success.

## Implementation lanes

1. **Frontend and contracts:** add selected/all mode to shared editor, onboarding
   draft, review, persisted configuration and main GitHub view. Preserve compact
   existing components. Wire real native commands/state; no fixture in production.
   Contract per workspace: `repositoryMode: selected|all`,
   `allRepositoriesAllowChanges: boolean`, existing `repositories` and `identity`.
2. **Native account/policy:** GitHub browser OAuth with random state and PKCE,
   loopback callback, secure-store credentials, refresh/revoke, paginated real App
   installation catalog, durable per-VM policy, truthful apply/error state, and
   Tauri commands. Keep all tokens out of the frontend and serialized runtime state.
3. **Trusted token service:** TypeScript with maintained Octokit OAuth methods;
   exchange authorization codes, refresh/revoke and request restricted tokens.
   Hold the App client secret only server-side. Fixed GitHub destinations, bounded
   inputs/timeouts, no credential logging/storage, no open relay. Document deploy
   configuration and real App registration. No invented production domain or
   embedded secrets; actual deployment needs a real host and App configuration.
4. **Runtime:** extend the pinned MicroSandbox boundary, not a second general
   proxy. Prepare stable disabled access when creating VMs; host-owned per-VM
   grants and credentials, expected auth fields only, current policy per request,
   cancellation of stale connections, live connect/disconnect/refresh. Standard
   Git/LFS/gh clients, verified TLS, no raw persisted secrets. Apply author settings
   using normal live Git/jj config; general secret add/rename may require restart.
5. **Integration and host Push:** wire catalog/policy to runtime with acknowledged
   revisions, bounded retry and fail-closed recovery. Explicit host Push transfers
   selected committed Git/LFS data through trusted isolated host Git, never guest
   hooks/config and never temporarily enabling guest writes. Validate LFS action
   scope; approved temporary object download links may enter the guest.
6. **Independent review and delivery:** inspect security/spec compliance separately
   from maintainability; fix findings. Update this plan with actual results and
   remaining deployment/platform constraints. Commit only this task's changes.

## Verification

- Focused TS/Rust/service tests: selected/all persistence and future-catalog
  changes, read-only defaults, malformed policies, OAuth state/PKCE/callback
  rejection, pagination/expiry/refresh, unavailable secure store, no-token state.
- Request-boundary tests: exact VM/owner/repository grants, read/write protocols,
  wrong hosts/auth headers/redirects, ambiguous GraphQL, unknown IDs, no broad
  fallback, partial writes, keepalive/HTTP2 and in-flight cancellation on revocation.
- Actual disposable VM/private fixtures: clone/fetch/push, gh issues/PRs/API,
  LFS bytes, author change without restart, connect after disconnected boot,
  revocation/reconnect and relaunch. Never treat an unavailable live check as pass.
- `npm --prefix app/SiloUI test`, typecheck/build/lint; focused native cargo tests;
  service tests/build; rebuild the bundled patched runtime where changed.
- UI: launch the real Tauri bundle; onboarding GitHub Connect → browser → return;
  choose selected versus all, toggle writes, continue/review/finish, reopen main
  GitHub screen; verify persisted choices. Add/remove an authorized repo and verify
  all mode updates. Repeat with GitHub skipped, network failure, denied access and
  retry. Inspect screenshots at normal size for unchanged spacing and one-line
  normal captions. No debug/staging controls.

## Evidence retained from the removed POC

45 local tests, 10 live GraphQL checks, 10 Git checks, 21 stock-gh checks,
15 scoped-token checks (including a reproduced compatibility limit and cleanup),
8 LFS checks. These were separate proofs, not full VM isolation certification.
Native scoping denied nested forbidden data; a mixed write-B/read-A request wrote
B then denied A. LFS signed download URLs worked and removing signatures gave 403.
Actual VM credential reflection and Linux/live-connection security remained unproven.

## Primary references

- https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token
- https://github.com/octokit/oauth-methods.js
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/
- https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab
- https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md

## Implementation and verification status

Implemented in production code:

- Selected/all repository controls, read-only defaults, native account operations,
  persistent per-VM choices and authoritative success/failure state. A failed
  account connection produces one account error, not fabricated VM failures.
- Native OAuth/PKCE, installation handoff, Keychain/Secret Service account and
  runtime-token storage, renewal, individual-token retirement and retry after
  relaunch. Catalog refresh notices newly authorized owners/repositories.
  Background credential renewal never starts VMs to rewrite Git identity;
  identity writes are limited to explicit saves/retries and remain independent
  of GitHub token failures.
- Octokit exchange/refresh/revoke/scope service. The shared App secret is never
  compiled into Silo. Production App permissions must be repository-only;
  organization/account administration cannot be confined by a repository choice.
- Patched MicroSandbox HTTP boundary with exact Authorization substitution,
  scoped read/write credentials, live cancellation, Git/LFS classification and
  GraphQL operation parsing. For node-ID operations, bounded read-only GitHub
  probes resolve the owner before the original request is forwarded once.
  Unknown/ambiguous authority fails; mutations are never automatically replayed.
- VM provisioning installs Git, gh, Git LFS and CA certificates from signed Ubuntu
  packages when absent, then verifies the stopped state. These guest packages
  currently require network access at first creation; they are not yet baked into
  a shipped guest image. Author updates use ordinary live Git/jj configuration.
- Explicit host Push imports committed bundles into isolated bundled Git, checks
  objects, verifies LFS hashes, and performs a non-force push. Guest hooks/config
  and dirty files do not become host Git configuration or committed data. Binary
  transfers stream through a host-created file with a disk budget and kernel cap.

The runtime patch is pinned to
`e6868dfbef5e7800949adbad98bda7fa501e8df47ac7146e601b50f145349ee8`.
A native regression compares the checked-in patch with the manifest expectation,
preventing a build from rejecting its own correctly packaged runtime.

### Checks completed

- `npm --prefix app/SiloUI test`: 465 tests passed across 52 files.
- `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --offline -- --test-threads=1`:
  144 tests passed; two hardware-dependent tests were excluded from the normal run.
  The GitHub hardware test was subsequently run explicitly and passed.
- `npm --prefix services/github-auth test`: 16 service tests passed, including
  outbound PKCE, scoped permissions and individual-token deletion semantics.
- After the final account-error UI correction, all 68 application-page tests
  passed, including a regression that keeps failed sign-in retry on Connect.
- Patched runtime: 124 secret/parser/resolver tests and two relay-cancellation
  tests passed; the pinned source patch applied cleanly and built successfully.
- Host Push: real bundled Git proved committed-object isolation; real Git LFS
  uploaded identical synthetic bytes to an isolated local remote.
- Hardware regression `github_guest_bootstrap_and_live_identity`: passed in a
  disposable VM. It exercises production creation/provisioning, stopped-state
  restoration, installed Git/gh/LFS, placeholder-only guest credentials, live
  author changes, disabled-access refusal, independent TLS trust, live replacement
  with a synthetic invalid credential and subsequent disable, unchanged boot ID,
  and exact binary transfer. It stops and removes its own VM.
- `npm --prefix app/SiloUI run desktop:build:debug`: built the ad-hoc signed macOS
  application, including the hypervisor-entitled MicroSandbox helper. Not notarized.
- Launched `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app` in normal
  production mode. The runtime loaded without a manifest warning. GitHub → Connect
  showed one missing-configuration error, kept Connect available, and showed
  neither repository retry nor invented per-VM failures. Restored dev and
  playgrounds to Stopped; personal remained Stopped. These were real VM states.
  Connected repository controls still need the authenticated UI verification below.

Repeat the hardware regression with the packaged helper (it requires virtualization
and Ubuntu/GitHub network access):

```sh
SILO_TEST_MSB="$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb" \
SILO_TEST_LIBKRUNFW="$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/Frameworks/libkrunfw.5.dylib" \
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml \
  github_guest_bootstrap_and_live_identity -- --ignored
```

### Remaining release verification

The production service URL, GitHub App client ID/slug and server secret have not
been configured. The app reports this honestly when Connect is pressed. No live
OAuth success, GitHub-authenticated VM/host Push, child-token versus parent-token
revocation proof, complete GitHub command compatibility, Linux runtime execution,
or absolute credential-exfiltration guarantee is claimed from these tests.

Configure and deploy the service using `services/github-auth/README.md`, register
the production App, rebuild with its three public build settings, and execute the
UI and authenticated private-repository matrix above. The removed POC is not a
substitute for testing this implementation. Old development VMs need recreation
for the new credential facility; no migration code was added.

## Live editing and rate-limit handling

Repository choices save immediately. Additions and write enablement are combined
for 500 ms after the latest edit; no Save/Cancel controls are added. Removals and
write disablement first detach the affected authority through local runtime IPC,
without waiting for GitHub requests or the debounce. If that local update fails,
Silo reports failure rather than claiming the access was removed. Starting a VM
and updating its credentials are ordered per VM to prevent an old boot credential
from overriding a newer choice; long guest commands do not hold that lock.

Only changed owner/read/write groups obtain replacement tokens. Identical scopes
reuse unexpired tokens, and Git/jj author changes do not request credentials.
Superseded results cannot attach after a newer edit; issued credentials are tracked
for reuse or retirement even when a later request fails. A read-scope replacement
can briefly pause its owner's writes because the runtime profile pairs the owner's
read and write credentials; the unchanged write token is retained. Applying a
changed profile closes existing VM proxy connections, but does not restart the VM.

The service forwards confirmed rate limits and safe retry metadata. Native token
management honors Retry-After and exhausted x-ratelimit-reset, uses exponential
backoff with positive jitter, and stops after five automatic retries. Explicit
Retry preserves GitHub's waiting period; the shared rate deadline survives app
relaunch. Permission errors and ambiguous token-creation/refresh failures do not
get automatic replays. Safe reads and idempotent revocations can retry. Git pushes
and VM write API requests are not replayed by this mechanism.

The existing progress/error messages describe pending work and retry delays.
Onboarding waits for acknowledgement of the exact saved policy revision. Older
responses cannot replace newer UI settings or complete a superseded setup job.

Sources: [GitHub best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately)
and [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
