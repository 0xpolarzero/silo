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

## GITHUB-TOKENS-4 — P2: Repository Refresh replays unrelated ambiguous token requests

- **Trigger:** A workspace token mint or rotating OAuth refresh fails after sending; the user clicks Refresh repositories.
- **Evidence:** `refresh_github_repositories` called the global `reset_retries` before acquiring the GitHub operation lock. That erased the stopped request's refusal, permitting the worker to attempt it again. The existing adjacent GITHUB-HTTP-4 report identified this remaining caller; this loop reproduced it.
- **Consequence:** A catalog refresh silently authorizes another unsafe token request whose first outcome is unknown.
- **Fix:** Retain the existing safe-operation flag in each failure and reset only safe requests for catalog refresh. Reset inside `run`, after its operation lock and update guard are acquired. Explicit configuration Retry keeps its existing scope and behavior.
- **Regression:** `repository_refresh_preserves_ambiguous_writes_and_server_floors` failed because Repository Refresh reopened an ambiguous mint. The fixed test permits a failed safe read, retains both stopped mint and rotating-refresh refusals, and proves the server deadline still blocks early requests.
- **Verification:** Actual HTTP/token source modules in the synthetic Rust harness; no application, live credentials or VM used. All 36 focused tests, focused Clippy, Rust formatting, frontend typecheck/lint and whitespace checks passed. Red/green output is under the ignored shared verification directory.

## GITHUB-TOKENS-5 — P2: Rejected non-expiring exchanges lose their live token

- **Trigger:** The GitHub App has opted out of expiring user tokens. Connect exchanges a valid code and receives an access token without refresh or expiration fields.
- **Evidence:** GitHub [documents this supported response](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app). `session` correctly rejects it because Silo requires rotation, but the rejection occurs before `connect` constructs its `Unstored` cleanup guard.
- **Consequence:** Connect returns an error and loses a newly issued live, non-expiring token without attempting revocation.
- **Fix:** When session validation rejects a completed exchange, attempt individual-token revocation for its valid access token before returning the validation error. Do not revoke the whole grant because a previous connection may share it. Refresh keeps its separate consumed-token retention flow.
- **Regression:** `rejected_exchange_revokes_its_unstored_token_without_revoking_the_grant` failed with one network call instead of exchange plus cleanup. It covers the documented non-expiring response, invalid session lifetime, App-authenticated individual-token DELETE, and omission of cleanup when no valid token was returned.
- **Limits:** Cleanup follows the existing best-effort discarded-credential policy; a failed cleanup request cannot guarantee revocation. Durable retirement of rejected account exchanges requires separate lifecycle work.
- **Verification:** All 38 tests in the actual HTTP/token modules passed with synthetic fixtures. Focused Clippy, Rust formatting, frontend typecheck/lint and whitespace checks passed. Native Cargo remains queued on the shared target lock.
