# GitHub frontend fix-loop review

Scope: `app/SiloUI/src/features/github/`. Tests use mocked callbacks and deterministic frontend data; no app, real credentials, or VMs were used.

## FE-GITHUB-1 — P2 — Stale token-removal retry

- **File:line at review base `2c78975b`:** `app/SiloUI/src/features/github/components/personal-token-connection.tsx:31`.
- **Trigger:** Fail removal of token A, successfully replace it with B, then invoke the old removal toast's Retry. The callback also remains callable during replacement and after component teardown.
- **Consequence:** Removal targets the currently stored token, deleting B or starting an overlapping credential operation.
- **Suggested fix:** Invalidate obsolete retries, dismiss their toast, and guard all token operations synchronously.
- **Regression:** Added tests reproduce replacement, duplicate retry, and teardown failures before the fix. All pass after the fix.
- **Status:** Fixed and folded in `775bea0a`; notification cleanup restricted to owned removal failures in `78772939`. The cleanup follow-up has its own regression and passes the GitHub page notification suite.

## FE-GITHUB-2 — P2 — Catalog changes redirect repository selection

- **File:line at review base `0c1b2cbe`:** `app/SiloUI/src/features/github/components/github-access-editor.tsx:72`, `:131–134`.
- **Trigger:** Open the repository picker, highlight `acme/silo` at index 1, then refresh the catalog from `[acme/base, acme/silo]` to `[acme/base, acme/other, acme/silo]`. Press Enter. Removing the highlighted repository or adding a result before the highlighted authorization action produces the same mismatch.
- **Evidence:** The component stores the numeric `activeIndex` but resolves Enter against the latest `results` array. A deterministic rerender test submitted `acme/other` instead of `acme/silo`. Separate tests reproduced selection of an unrelated remaining repository after removal and selection of a repository instead of running GitHub authorization. Exact failing output: `/tmp/silo-fe-github-catalog-red.log`.
- **Consequence:** The picker sends the wrong repository to `onWorkspaceSelectionsChange`; the application page immediately applies that repository-access draft. A catalog update can therefore grant read access to a repository the user did not select.
- **Suggested fix:** Track the highlighted repository/action by identity, resolve its current index for rendering, and leave no active result when that identity disappears until the user navigates again.
- **Regression:** Three component behavior tests cover reordered results, removed results, and a moved GitHub authorization action.
- **Status:** Fixed and folded in `38c15b9f`.

## FE-GITHUB-3 — P2 — Inherited workspace keys crash GitHub settings

- **File:line at review base `0f1186bf`:** `app/SiloUI/src/features/github/components/github-access-editor.tsx:306–308`, `:485`.
- **Trigger:** A newly discovered local sandbox is named `constructor`. The application page renders the latest source workspace list while its stateful draft still lacks that sandbox's selections and identity; synchronization runs after rendering. The name passes `validateSandboxName` in `src/features/onboarding/model/machine-configuration.ts`.
- **Evidence:** A rerender test against the actual `GitHubPage` with deterministic fixture source data fails with `TypeError: selections.map is not a function`. Plain object lookup returns inherited `Object.prototype.constructor` instead of taking the empty-selection fallback. That function has a nonzero length, so the editor enters its selected-repository table branch and calls its nonexistent `map` method. Identity and access lookups have the same inherited-key problem. Exact failing output: `/tmp/silo-fe-github-constructor-page-red.log`.
- **Consequence:** GitHub settings fail to render before the page can synchronize the new sandbox's draft.
- **Suggested fix:** Read only own properties from the workspace dictionaries, preserving the existing defaults for missing entries and legitimate saved settings with that name.
- **Regression:** Component tests cover missing and saved entries named `constructor`; a page-level source-rerender test reproduces the actual draft synchronization seam.
- **Status:** Fixed; component regressions pass.

Verification: 18 GitHub component tests pass. The token and GitHub-page notification suites pass all 14 tests after the owned-toast cleanup correction. The initial broader run hit a 5-second timeout in the existing interleaved repository/identity test under host contention; that test passes in isolation with one worker and a 15-second timeout. Focused lint, TypeScript checking, Rust formatting, and whitespace checks were run for the fixes. No native build or live-state validation was performed.

## FE-GITHUB-4 — P2 — Disabling an incomplete Git identity is never saved

- **File:line at review base `2df5bc93`:** `app/SiloUI/src/features/application/pages/github-page.tsx:295–296`.
- **Trigger:** Clear the Git name or email for a sandbox whose identity is applied, then turn off Apply.
- **Evidence:** Both field variants fail a page-level behavior test because `saveGitHubConfiguration` is never called. `commitIdentity` rejects empty author fields before considering `apply`. Native `github.rs` validation requires nonempty fields only when `identity.apply` is true; `github-failure.ts` also instructs users to turn off Apply instead of supplying an author. Exact failing output: `/tmp/silo-fe-github-identity-off-red.log`.
- **Consequence:** The checkbox shows Apply off while the saved policy still applies the previous Git identity.
- **Suggested fix:** Require name and email only when applying an identity, retaining the existing incomplete-edit guard when Apply is on.
- **Regression:** Two parameterized page tests clear each field, disable Apply, inspect the save, and verify the state survives an authoritative snapshot.
- **Status:** Fixed and folded in `f7e252ef`; five focused identity/retry regressions pass, along with typecheck, focused lint, and formatting checks.

## FE-GITHUB-5 — P2 — Token users cannot toggle global access without OAuth

- **File:line at review base `5d20324a`:** `app/SiloUI/src/features/application/pages/github-page.tsx:347–358`, `:394`; `app/SiloUI/src/features/github/components/github-access-editor.tsx:304`.
- **Trigger:** Connect a personal token while OAuth is disconnected or connecting, with global GitHub access either disabled or enabled. Disconnecting OAuth sets `access_enabled` to false in native `disconnect_github`; connecting a personal token does not reset it.
- **Evidence:** Four page-level tests covering both OAuth states and both access values fail because Enable/Disable access is absent. The toggle is passed only through `connectedActions`, rendered only for connected OAuth. Native `set_github_access_enabled` supports the global switch independently, and personal-token attachment explicitly requires `access_enabled`. Exact failing output: `/tmp/silo-fe-github-token-access-red.log`.
- **Consequence:** Token users cannot enable sandbox token access after disconnecting OAuth or use the global kill switch while OAuth is unavailable.
- **Suggested fix:** Show the same global access control whenever a personal token is connected, independent of OAuth's connection state.
- **Regression:** Four page tests toggle access with token authentication, verify no OAuth connection is initiated, and check the button updates from an authoritative snapshot.
