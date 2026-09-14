# Personal GitHub tokens

2026-09-14. Implemented as an alternate connection alongside the existing GitHub
App OAuth flow. A user can connect either method or both, including different
accounts, and choose one method per local VM in the GitHub page.

## Behavior

- Existing VM policies default to OAuth. New policies also default to OAuth.
- The personal-token connection accepts classic and fine-grained tokens. Silo
  validates the token with GitHub's read-only `/user` endpoint before saving it.
  Validation does not require any existing repositories.
- Each VM offers mutually exclusive Use GitHub OAuth and Use token options.
  Each option is enabled only when that connection is connected. Losing a
  connection preserves the selected method; it never falls back to the other.
- Token mode uses the token's full permissions. OAuth repository and read/write
  controls are hidden in token mode, and their selections are preserved when
  switching back. A tooltip describes full token access.
- Token connection, replacement and removal are independent of OAuth login.
  Removing the saved token detaches it locally; it does not revoke the user's
  token on GitHub or remove the OAuth connection.
- The existing worker validates saved tokens at startup and every five minutes,
  with a 30-second retry after network/validation failure. Disconnected tokens
  are detached; the UI offers replacement without a manual test button.
  Individual GitHub API permission errors remain GitHub's responsibility.

## Credential boundaries

The password input is cleared at submission. Its value crosses a dedicated
main-window native command once, never a general configuration save. No returned
snapshot, durable JSON document, activity, or error includes the token.

The native backend stores the credential in the OS credential store under the
separate personal-token entry. Public snapshots read only a process-local status
observation and cannot trigger credential-store dialogs. A removal intent is
persisted before detachment so a failed credential deletion cannot silently
reattach the token after relaunch.

The runtime uses an explicit version-2 personal-token profile, independent of
OAuth owner/repository grants. The proxy replaces the exact placeholder only in
GitHub Authorization headers, including Git Basic authentication, under verified
TLS. Bodies, queries and unrelated headers are not substituted. Unsupported
hosts and malformed/mixed profiles fail closed. Tokens do not enter OAuth child
issuance or revocation ledgers. Host Push honors the selected method too.

The updated CLI checks the running VM's token-profile capability before sending
a personal-token update. A VM running an older proxy must be restarted once;
Silo does not report a successful attachment to an incompatible proxy. Changing
connections in a compatible running VM uses the existing live secret update and
connection invalidation mechanism.

## Verification

Synthetic tests cover independent selector availability, default OAuth behavior,
preserving an unavailable selection, token input clearing, redacted failures,
public-state parsing, empty-account validation and native command permissions.
Patched proxy tests cover REST creation/deletion, GraphQL creation, Git writes,
Basic authentication, and header-only substitution. Existing OAuth regression
checks remain applicable.

Commands used:

```sh
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
npm --prefix app/SiloUI test -- src/features/github src/features/application/application-app.test.tsx src/desktop/production-source.test.ts
npm --prefix app/SiloUI run test:release
# Native GitHub tests use explicit synthetic build configuration, per the release guide.
cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml github
```

The pinned runtime patch is also applied to a fresh cached source archive under
`app/SiloUI/src-tauri/target/verification/github-token-runtime/` and checked with
Rust 1.94.0. Its network tests run against the actual patched source; the CLI,
SDK and runtime compile with the shipped net/ssh feature combination.
Browser layout/interaction checks use synthetic OAuth and token accounts.
No real token, live VM or packaged Silo bundle was exercised. Live repository
creation and secure-store integration require a subsequent authorized live test.

## Primary references

GitHub's [personal-token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
documents classic and fine-grained tokens, one resource owner per fine-grained
token, permission differences and organization restrictions. Full token access
means all authority granted to that token, not permissions beyond the user or
GitHub's authorization.

The [repository creation endpoint](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)
documents the permissions needed to create the first repository. Silo forwards
that request using the selected token without deriving grants from existing
repositories.
