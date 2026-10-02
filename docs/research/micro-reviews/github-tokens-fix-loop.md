# GitHub token operations: fix-loop review

Scope: `app/SiloUI/src-tauri/src/github_tokens.rs`.

## GITHUB-TOKENS-1: Valid dotted App client IDs fail every token operation

- **Priority:** P2.
- **Location:** `github_tokens.rs:138` before the fix.
- **Trigger:** Configure a valid dotted App client ID and perform any token operation.
- **Evidence:** The shared validator required ASCII alphanumeric bytes. GitHub's [App response](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app) documents `Iv1.ab1112223334445c`. Build configuration accepted that value. Parameterized exchange, refresh/revocation and scope tests failed with `Invalid GitHub authorization request.` before the fix.
- **Consequence:** Source builds using that App cannot sign in, refresh, scope or revoke credentials.
- **Fix:** Accept dots while rejecting URL path separators, controls and standalone dot segments. Fixed and folded in `9fad68c9`.
- **Regression:** Both client ID formats reach the transport unchanged across all five operations; unsafe IDs fail before any transport call.

## GITHUB-TOKENS-2: Optional installation client ID is treated as mandatory

- **Priority:** P2.
- **Location:** `github_tokens.rs:264` before the fix.
- **Trigger:** GitHub returns an otherwise matching owner installation without `client_id`.
- **Evidence:** GitHub's [user installation endpoint](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token) lists installations of the authenticated token's App. Its response example omits `client_id`. GitHub's [OpenAPI installation schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json) defines `client_id` as a string but excludes it from the installation's required fields. Comparing the absent JSON field with the configured ID discarded the installation. The new omission regression failed with `This GitHub owner is not authorized for Silo.` before the fix.
- **Consequence:** Authorized repositories remain visible through the catalog, but sandbox grant creation fails with a false authorization error.
- **Fix:** Accept omission; reject a supplied mismatched or non-string ID. Continue checking owner, suspension and repository permissions.
- **Regression:** An omitted ID mints the requested restricted credential. Explicit null, number, object, array and mismatched IDs never mint.

Focused verification imports the unchanged token and HTTP modules into a temporary harness under `/tmp/silo-codex-target/verification/github-tokens/` and links the shared cache's compiled dependencies. The harness supplies a mutex for the HTTP tests' process-state guard; it does not include application startup or runtime shutdown. The final focused run passed 30 tests. Formatting, frontend typecheck and frontend lint passed. Focused Clippy passed with two existing HTTP-module lints allowed only on that module. Full Cargo verification was queued on the shared target lock at the time of this commit. No application, real credential or VM was used.

## GITHUB-TOKENS-3: OAuth configuration errors cause an unrevoked disconnect

- **Priority:** P2.
- **Location:** `github_http.rs:338`, consumed by `github.rs:929` and the disconnect worker.
- **Trigger:** Disconnect with an account token within its refresh window while GitHub returns `incorrect_client_credentials` for renewal, such as after a source build ships an incorrect App secret.
- **Evidence:** The transport classified every HTTP 200 OAuth error as `authorization_rejected`. `live_access_token` interpreted that marker as no usable account credential, so the disconnect worker skipped grant revocation and deleted the stored credential. GitHub's [token troubleshooting contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#troubleshooting) distinguishes incorrect App configuration from an invalid or expired refresh token. The local wire-response regression failed on `incorrect_client_credentials` before the fix.
- **Consequence:** Disconnect could report completion and forget a valid refresh credential without revoking its authorization.
- **Fix:** Reserve the unusable-refresh classification for `bad_refresh_token`. Other OAuth errors remain failures and retain the pending revocation and credential. Continue redacting provider descriptions.
- **Regression:** Local HTTP responses for incorrect client credentials, unsupported grant type, unverified email and an unavailable provider do not classify the credential as unusable. An explicit bad refresh token does. The focused token/HTTP run passed 34 tests after the change; no live account was used.
