# GitHub token operations micro-review

Scope: `app/SiloUI/src-tauri/src/github_tokens.rs`.

## GITHUB-TOKENS-1: Valid dotted GitHub App client IDs fail every token operation

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/github_tokens.rs:138`.
- **Trigger:** Build with a valid GitHub App client ID containing a dot, such as GitHub's documented `Iv1.ab1112223334445c`, then exchange an authorization code, refresh a session, scope a token, or revoke a token/grant.
- **Evidence:** The shared `execute_with` precondition requires every client ID byte to be ASCII alphanumeric and returns `Invalid GitHub authorization request.` before dispatch. GitHub's [Get the authenticated app response](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app) includes the dotted ID above; its [manifest conversion response](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest) also includes a dotted client ID. The build configuration accepts dots (`src-tauri/github_build.rs:28` rejects empty/trimmed values and newline/NUL injection only), and `github.rs:767–777` passes the configured ID through unchanged. Thus this is a reachable runtime rejection of accepted, valid configuration. Existing tests exclusively use `Iv23test` and do not cover the documented format. No matching finding appeared in the required earlier review reports.
- **Consequence:** A build using that App cannot complete sign-in or perform any token-management operation. The current default alphanumeric App ID is unaffected.
- **Suggested fix:** Accept the documented dotted client ID format while retaining validation against path separators and control characters; alternatively encode the client ID as a single URL path segment and validate it as an opaque provider identifier.
- **Test that would catch it:** Parameterize the existing exchange, refresh, scope, and revocation tests over `Iv23test` and a dotted `Iv1.` fixture. Supply matching installation client IDs for scope. Assert that the fake transport is reached and the configured ID is preserved in OAuth bodies, App authentication, and token-management URL paths. Retain rejection tests for slash/control-character IDs.

Verification: source inspection and primary GitHub documentation only. No builds, tests, live credentials, or application instances were used, as required by `/tmp/silo-micro.md`.
