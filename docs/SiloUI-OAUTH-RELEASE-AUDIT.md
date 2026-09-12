# GitHub client-secret release audit

Date: 2026-09-12. Scope: the report that Silo 0.1.1 exposed its production
GitHub App client secret through public desktop packages.

## Verdict

The client secret is present and extractable in the sampled public executables.
This is the documented public-client architecture, not evidence of an OAuth
authorization bypass. No vulnerability caused by distributing this value was
found in the audited flow. Live GitHub requests confirmed that possession of the
real client secret and a valid PKCE-bound authorization code does not suffice
without the correct verifier.

GitHub explicitly documents shipping client secrets in native public clients and
using PKCE. It recommends authorization code with PKCE over enabling device flow
for ordinary desktop applications. RFC 8252 section 8.5 explains that a shared
native-client secret cannot authenticate the installed software's identity.
Neither a future backend nor a repository-access decision may rely on its
confidentiality. [1][2]

Rotation followed by shipping a replacement would reproduce the same condition
and break old clients' exchanges and refreshes. This finding alone does not
justify rotation or release removal. Reuse in a confidential service, exposed
user tokens/private keys, or demonstrated misuse would require separate incident
handling.

## Verified evidence

- Anonymous GitHub REST release metadata reports `v0.1.1`, `draft: false`,
  `immutable: true`, published `2026-09-10T17:19:18Z`. Local annotated tag peels
  to commit `87758ce00167951cb1304b9a4be9e1ae23122414`.
- Downloaded `Silo-macos-arm64.app.tar.gz` and `Silo-linux-x64.deb` without
  authentication. Both SHA-256 digests match the public `SHA256SUMS` manifest.
  This checks consistency with the release, not independent build provenance.
- Read `Silo.app/Contents/MacOS/silo-ui` and `./usr/bin/silo-ui` directly from
  their archives without executing the packages. Each contains an exact byte
  match for the locally configured client secret. The locally configured
  secret's suffix also matches the only active secret shown in App settings.
  No secret value was printed or added to this report.
- The build loads configuration with `cargo:rustc-env`; `github.rs` reads it
  using `option_env!`. The release workflow supplies the Actions secret during
  compilation. Hiding Actions log values does not hide compiled values.
- `github.rs`, `github_tokens.rs`, and `github_http.rs` have no differences
  between the audited checkout and `v0.1.1`.
- Narrow executable scans found zero matching GitHub bearer-token patterns and
  zero complete PEM private-key blocks. These pattern scans cannot establish
  that every possible credential format is absent.

### Live App settings

Read the authenticated GitHub settings UI; changed no settings:

| Setting | Observed value |
| --- | --- |
| App | `microsandbox-workspaces`, App ID `4605731` |
| Client ID | `Iv23liEjp3VnGe0sw2LU` |
| Redirect URI | One entry: `http://127.0.0.1/github/callback` |
| Wildcard matching | Disabled |
| Device flow | Disabled |
| OAuth during installation | Disabled |
| User-token expiration | Enabled, eight-hour access tokens |
| Webhook | Inactive, no configured URL |
| Private keys | No existing private-key entries shown |
| Repository permissions | 14 selected plus mandatory metadata |
| Organization/account/enterprise categories | No selected-permission counts shown |

Selected repository permissions are actions, commit statuses, contents,
discussions, issues, merge queues, packages, pages, projects, pull requests and
workflows with write access; administration, artifact metadata and deployments
with read access; mandatory metadata is read-only. The public client secret
does not itself convey these permissions. A user's authorization is still
required. This audit does not certify that every selected permission is the
minimum needed by every feature.

### Code inspection

- Authorization opens the external browser after binding `127.0.0.1` on an
  ephemeral port. State and verifier are independently generated from random
  UUIDs. The challenge uses SHA-256 and unpadded base64url (`S256`).
- Callback parsing requires the expected path, exactly one matching state and
  exactly one nonempty authorization code. Wrong state and unrelated traffic
  cannot create a session. Header reads are bounded.
- The token exchange sends the verifier and same loopback redirect URI to the
  fixed HTTPS GitHub token endpoint. Refresh requires an actual refresh token.
- HTTP transport restricts destinations to GitHub HTTPS hosts, disables
  redirects, and does not disable TLS verification. Error handling redacts
  provider response details; retry identifiers hash credentials.
- User credentials are stored through the native credential store. Public
  snapshots omit bearer credentials. The native token-operation helper is not
  exposed as an arbitrary WebView token-exchange command.
- Scope and revoke operations also require an actual user token. The repository
  scope helper binds owner and repository selection and fails on unsupported
  non-repository permissions. No hosted exchange service is used by this flow.

### Live PKCE reproduction

Used an isolated temporary loopback listener and the existing browser grant,
without reading or replacing Silo's saved account. A disposable Python probe
sent requests directly to GitHub with the configured client credentials.
It used no repository APIs and changed no repositories or App permissions.

| Independent authorization attempt | Result |
| --- | --- |
| Real secret and fresh code, verifier omitted | HTTP 400, `invalid_grant`, no token |
| Real secret and fresh code, incorrect verifier | HTTP 400, `invalid_grant`, no token |
| Real secret and fresh code, correct verifier | HTTP 200, token issued |
| Revoke the isolated successful token | HTTP 204 |

The initial omitted-verifier attempt invalidated its code: subsequent exchanges
using that same code returned `bad_verification_code`, including the correct
verifier. Consequently the wrong-verifier and successful controls each used a
fresh authorization attempt. They are not conclusions drawn from a consumed code.
The live probe validates provider enforcement; the inspected Rust implementation
and local tests supply separate evidence for Silo's behavior.

## Commands and results

Anonymous downloads used `curl -fsSL` against the release API and versioned asset
URLs. Python `tarfile`, an ar-member parser, and `hashlib.sha256` inspected the
archives and compared the credential in memory, outputting booleans only.

```sh
git diff v0.1.1 -- app/SiloUI/src-tauri/src/github.rs \
  app/SiloUI/src-tauri/src/github_tokens.rs \
  app/SiloUI/src-tauri/src/github_http.rs

SILO_GITHUB_APP_SLUG=audit-fixture \
SILO_GITHUB_CLIENT_ID=auditfixture \
SILO_GITHUB_CLIENT_SECRET=audit-fixture-secret \
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml \
  --offline github -- --test-threads=1
```

The source comparison was empty. The first test run passed 70 tests and failed
one transport test because the execution sandbox denied binding a loopback
socket. Repeating with socket access passed **71 tests, zero failures, four
ignored live tests**. The filtered run did not execute the five build-config
integration tests. Synthetic test credentials were used; test binaries are not
distribution packages.

Ignored local evidence is under
`app/SiloUI/src-tauri/target/verification/oauth-audit/`: downloaded archives,
checksum manifest, sampled executables, `tests.log`, `tests-unsandboxed.log`,
the disposable `probe.py`, and sanitized live-probe JSON results. Probe listeners
exited and the sole issued test token was revoked. Silo and its VMs were not
launched, quit, rebuilt, or modified.

## Limits and release communication

This is a focused credential-distribution audit, not certification of the entire
application. It did not inspect every installer variant or Linux ARM64 package,
prove reproducible builds, execute the downloaded application, test live VM
isolation, or rerun the private-repository mutation suite. It did not inspect
historical OAuth activity across all users, establish absence of misuse, or
independently establish the original publishing approval conversation. The
settings UI's recent secret-use indicator cannot distinguish legitimate use
from abuse. No conclusion about unrelated services reusing the credential is
possible from this repository alone.

The existing documentation explicitly declares the credential extractable.
That documents intent in the codebase but does not prove the publisher received
a clear notice. Future release reviews should say that packages distribute the
GitHub public-client secret, distinguish it from private keys and user tokens,
and retain the public-client threat assumption. The next security action is to
preserve this boundary: never use these distributed App credentials as proof
that a request came from an authentic Silo installation.

## Primary sources

1. [GitHub App best practices: client secrets](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#client-secrets), checked 2026-09-12.
2. [RFC 8252, section 8.5: Client Authentication](https://www.rfc-editor.org/rfc/rfc8252#section-8.5).
3. [Public Silo 0.1.1 release](https://github.com/0xpolarzero/silo/releases/tag/v0.1.1).
