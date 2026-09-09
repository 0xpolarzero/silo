# Server-free GitHub access for Silo

**Recommendation: keep GitHub-issued restricted user tokens and request them directly from Silo's native backend. Remove the proposed hosted service. Keep the existing VM proxy and live policy updates.**

GitHub explicitly supports native public clients distributing their OAuth client secret with PKCE. That value is different from the App private key. The earlier conclusion that a client-secret parameter necessarily requires a hosted service was incorrect. GitHub's own local MCP server documents this distributed-client pattern. [1][2]

This is a researched implementation proposal, not a claim that the corrected authenticated implementation has passed. Sources and local code were inspected on 2026-09-09. No GitHub credentials were generated, App settings changed, or authenticated experiments run for this report. The hosted implementation in `SiloUI-GITHUB-IMPLEMENTATION.md` is not the approved direction.

## The missing distinction

| Value | Purpose | Treatment in Silo |
|---|---|---|
| App client ID and client secret | Required public-client registration values for the selected GitHub APIs | Included in native release configuration; assume they can be extracted |
| App private key | Authenticates the App independently of an individual user's login | Never distributed; not needed for this design |
| User access and refresh tokens | Represent an individual user's authorization | Host secure storage only; never exposed to the UI or VM |
| Restricted child tokens | Carry a VM's permitted repository access | Host proxy only; guest receives placeholders |

GitHub's native-client guidance distinguishes these credentials. RFC 8252 section 8.5 says a shared value embedded in distributed applications is not confidential proof of application identity. Security must therefore not depend on hiding that embedded value. [1][3]

The scoped-token endpoint requires both the App credentials and an actual non-scoped user token. Its inputs include the owner, repository IDs and permission map. Knowing the App credentials alone supplies no user's repository authority. GitHub's check, reset and revoke endpoints also require the actual token being managed. [4][5]

The threat boundary is the user's host-only authorization. A VM must neither obtain it nor persuade Silo to use it on a guest-supplied request. The parent token must never enter a runtime proxy profile. Public-client impersonation remains possible: PKCE protects interception of a legitimate login code, not a person voluntarily approving an attacker's separate login flow. This is why the shipped App credentials must not become an authentication mechanism for any future Silo service. [3][6]

## Exact proposed flow

1. **Connect.** Silo binds a temporary listener on `127.0.0.1`, creates random state and an S256 PKCE challenge, and opens GitHub in the external browser. Register a fixed callback path and use GitHub's supported variable loopback port. This listener runs only during login on the user's computer; it is not an internet-hosted service. [7][8]
2. **Authorize.** The user grants access through the existing GitHub App and chooses its authorized repositories. Installation and user authorization are separate GitHub steps; Silo's existing installation-discovery flow still applies.
3. **Store login.** Native Silo verifies the returned state and exchanges the code and PKCE verifier directly with GitHub. The user token and refresh token go into macOS Keychain or Linux Secret Service. No credentials cross the React state bridge.
4. **Choose VM access.** Silo calls GitHub's scoped-token endpoint directly. Retain separate groups per VM and repository owner: a read token for readable repositories and a write token for the subset allowed to make changes. No network hop through a Silo-operated server. [4]
5. **Use Git and gh.** The existing host proxy replaces the guest placeholder with the appropriate restricted token. GitHub evaluates REST and GraphQL permissions. A routing hint never grants extra authority, and a failed request never falls back to the parent token.
6. **Edit without rebooting.** Preserve immediate local narrowing, 500 ms coalescing of additions, cached unchanged groups, expiry handling, cancellation of stale results and connection invalidation. Only changed grants are requested again. Git identity remains a separate live update.
7. **Refresh or disconnect.** Perform refresh and token revocation directly against GitHub, preserving secure storage and retry behavior. Expiring user tokens use rotating refresh credentials; interruption and ambiguous refresh results must be tested rather than blindly replayed. [5][9]

Use browser login with PKCE as the normal desktop path. Disable unnecessary Device Flow for the release App after explicitly reviewing that settings change. Device Flow can log in without an App secret, but does not remove the credential requirement of the scoped-token endpoint. It is not the solution to per-VM authority. [1][4][7]

## Why GraphQL no longer needs a new authorization system

The problematic alternative would inject one broadly authorized user token and try to determine locally which repositories each request touches. Parsing GraphQL only reveals the structure of a request. Validation checks that structure against the schema; authorization belongs in the server's business logic. [10][11]

For example, GitHub's issue schema allows traversal through cross-reference events to another issue or pull request. Checking only a query's starting repository is insufficient. The `transferIssue` mutation accepts both an issue and a destination repository, so validating one target is insufficient too. These are schema counterexamples, not claimed live exploits. [12]

No general GitHub GraphQL dry-run that returns an authoritative, complete permission decision was found in the documentation reviewed. Read probes cannot provide an atomic authorization check for a later mutation. Octokit's GraphQL package is an API client; it does not implement GitHub's authorization rules. [13]

**The recommendation avoids that problem:** GitHub receives a token whose permissions are already limited. The local proxy chooses credentials; it does not decide whether a GraphQL field is authorized. Existing bounded read probes can still help route an opaque node ID to an owner. They must use restricted read credentials, never the parent token.

Keep the previously accepted limit: a single operation spanning incompatible owner or permission groups can fail. Do not split or replay mutations to work around it. Users can issue separate requests. This is distinct from maintaining a list of supported command names.

## Alternatives and existing implementations

| Approach | Evidence | Decision |
|---|---|---|
| Direct native PKCE plus restricted user tokens | GitHub native guidance and scoped endpoint; distributed-client prior art | Recommended |
| Device login plus a broad token | Server-free login, but no full per-VM policy in the login exchange | Does not solve the gap |
| Broad-token proxy with GraphQL rules | Requires GitHub-specific field and mutation authorization | Reject as larger and harder to verify |
| Manually created fine-grained PATs | Repository and permission selection; GraphQL is supported today | Worse setup UX and additional token-management limitations |
| A separate GitHub App/private key per user | Could move App ownership to each user | Excess setup and credential-management burden |
| Hosted token service | Unnecessary given the supported native approach | Remove |

GitHub's own MCP server documents a compiled-in client secret and direct local PKCE exchange. Its default released registration is an OAuth App, while the documented flow also supports GitHub Apps. This proves the native login pattern is established; it is not a substitute for testing Silo's scoped-token behavior. VS Code's authentication source independently includes client-secret and PKCE-verifier parameters in its native exchange. [2][14]

Docker Sandboxes documents host-side credential injection and live credential changes, but those features alone do not establish per-repository GraphQL authorization. The `agent-sandbox` project takes a narrower route: its documented GitHub API support excludes GraphQL and most high-level gh use. Copying that restriction would violate Silo's requirement. [15][16]

Fine-grained PATs are not rejected because of GraphQL: GitHub now explicitly documents their GraphQL use. Their manual creation, owner constraints and feature gaps make them a worse default than normal App authorization. [17][18]

## Smallest implementation change

The repository already keeps token storage, login state, PKCE, policy reconciliation and runtime integration in Rust. The hosted TypeScript service currently adds five token operations through Octokit.

**Use the existing native HTTP client for those documented operations.** Keep OAuth checks and token policies in the native backend. Do not introduce a Node sidecar or send user tokens into the WebView merely to retain a JavaScript dependency. Octokit was a client library in the server implementation, not the component enforcing repository permissions. Its existing request-contract tests provide useful reference cases.

| Area | Change |
|---|---|
| `app/SiloUI/src-tauri/src/github.rs` | Replace calls to `/v1/oauth/*` and `/v1/tokens/*` with native GitHub operations; remove service-URL requirement |
| `app/SiloUI/src-tauri/src/github_http.rs` | Reuse bounded HTTPS transport and retry gates; normalize GitHub OAuth errors, status codes and rate headers directly |
| `services/github-auth` | Remove HTTP server, deployment package and service-only configuration after porting relevant tests |
| Runtime patch and guest setup | Retain scoped credential routing, placeholder-only guest setup and live invalidation; add focused attack regressions |
| Build configuration | Supply Silo's own App client ID, client secret and slug; no service URL or private key |
| Integration tests | Move tests to exercise the actual native token operations rather than an in-process server handler |
| UI | Preserve current Connect, repository selection, All repositories, progress and retry controls |

The five operations are code exchange, refresh, scope creation, individual-token revocation and whole-authorization revocation. Endpoint construction stays fixed to GitHub; guest requests cannot invoke these operations with host credentials. Preserve the distinction between confirmed rate limits, safe retries and ambiguous token issuance.

This is a change of transport and packaging, not replacement of GitHub authorization. The old Swift path used gh/device login and a Git/LFS proxy; it did not already establish arbitrary gh REST/GraphQL isolation. The current MicroSandbox patch explicitly relies on GitHub-scoped authority and should retain that design.

## Proof required before calling it complete

Use explicit disposable private repositories A, B and C, all available to the App. Give the test VM read access to A, write access to B and no access to C. Add a second owner for routing cases. Run against native Silo and its bundled runtime, without any Silo service configured.

| Test | Required result |
|---|---|
| Browser login, cancellation, relaunch | Correct account; correct state; no stuck Connecting; login persists securely |
| Incorrect or missing PKCE verifier; wrong state; duplicate callback | No authenticated session; use independent login attempts where required |
| VM access to the host login callback | Temporary loopback listener cannot be reached through the VM's host-network route |
| App credentials without a user token | Cannot obtain or manage another user's access |
| Restricted child used as parent; reset of a child | No broader repository or write authority; inspect the result, not just HTTP status |
| REST and GraphQL reads of A/B/C | Allowed reads work; C's private content remains unavailable |
| Node-ID mutations, aliases, fragments and cross-repository references | B writes work; A/C writes fail; forbidden nested content stays unavailable |
| Mixed-owner or incompatible requests | Explicit failure without broad-token fallback or replaying mutations |
| A multi-field mutation partially succeeds | Report GitHub's result without replaying the writes already applied |
| Git clone/fetch/push and Git LFS round trip | Read/write boundary holds and downloaded LFS bytes match |
| Guest env, files, credential helper, request bodies and token-management calls | No parent, refresh or restricted bearer token exposed |
| Redirects, alternative hosts, encoded placeholders and HTTP framing | Credentials attach only to the intended authenticated destination and header |
| Remove write access, remove a repository, disable and restore access | New requests reflect the acknowledged policy; VM boot ID unchanged |
| Rate limits, offline state, expiry and concurrent edits | Honest failure/pending state; no stale authority reapplied; bounded retries |
| Individual child revocation and parent refresh | Sibling/parent behavior verified; no accidental whole-account logout |
| macOS and Linux | Native build, secure-store behavior and real VM flow verified on each platform |

No mock, synthetic rejected token or documented endpoint alone establishes these authenticated results. Existing hardware tests remain useful regression evidence but do not satisfy this matrix.

The security promise must stay precise: Silo does not expose its host-held GitHub bearer tokens to a VM. That is not a promise against a VM escape, compromised host, a user authorizing an attacker, or exfiltration of repository data the VM may read. Previously issued signed download links and completed remote operations cannot be undone by a later local permission change. Broad repository administration permissions can also permit durable changes; revoking Silo access does not reverse them.

## One-time App setup after approval

Reuse `microsandbox-workspaces`. Configure the loopback callback, an App client secret for the distributed native client, expiring user tokens and the agreed repository permissions. Do not generate or distribute an App private key. Review disabling Device Flow. End users only authorize Silo and choose repositories; they do not create Apps, secrets, hosting accounts or PATs.

Release configuration may embed the client-secret value without committing it to source, as GitHub's own MCP build does. This avoids accidental publication in source workflows but does not make the distributed value confidential. No secret value is present in this report. [2]

**Next action:** approve the direct-native architecture, then port the five operations and execute the authenticated matrix before removing the remaining verification caveats.

## Sources

All sources accessed 2026-09-09. Documentation and main-branch code describe current behavior, not a pinned release certification.

1. GitHub Docs, [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).
2. GitHub, [Local Server OAuth Login](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md), official MCP server implementation documentation.
3. IETF, [RFC 8252, section 8.5](https://www.rfc-editor.org/rfc/rfc8252#section-8.5), October 2017.
4. GitHub Docs, [Create a scoped access token](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token).
5. GitHub Docs, [REST endpoints for OAuth authorizations](https://docs.github.com/en/rest/apps/oauth-applications).
6. GitHub Changelog, [PKCE support for OAuth and GitHub App authentication](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/), July 14, 2025.
7. GitHub Docs, [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
8. GitHub Docs, [About the user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).
9. GitHub Docs, [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
10. GraphQL Foundation, [Authorization](https://graphql.org/learn/authorization/).
11. GraphQL Foundation, [Validation](https://graphql.org/learn/validation/).
12. GitHub Docs, [GraphQL issue schema](https://docs.github.com/en/graphql/reference/issues), especially CrossReferencedEvent and TransferIssueInput.
13. Octokit, [GraphQL API client](https://github.com/octokit/graphql.js).
14. Microsoft, [VS Code GitHub authentication flows](https://github.com/microsoft/vscode/blob/main/extensions/github-authentication/src/flows.ts).
15. Docker Docs, [Manage credentials in Sandboxes](https://docs.docker.com/ai/sandboxes/configuration/credentials/).
16. mattolson/agent-sandbox, [GitHub access implementation](https://github.com/mattolson/agent-sandbox/blob/main/docs/github.md).
17. GitHub Docs, [Forming calls with GraphQL](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql).
18. GitHub Docs, [Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Local implementation evidence: `app/SiloUI/src-tauri/src/github.rs`, `github_http.rs`, `runtime_github_tests.rs`, `guest/setup-github.sh`, `app/SiloUI/patches/microsandbox-create-stopped-0.6.17.patch`, `services/github-auth/src/service.ts`, `app/Silo/Sources/GitHubProvider.swift`, `bin/silo`, and `lib/proxycore.py`.
