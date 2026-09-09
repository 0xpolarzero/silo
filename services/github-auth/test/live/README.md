# Authenticated GitHub regression

This permanent, opt-in regression uses the production `createHandler` and Octokit against GitHub. It is **not** part of `npm test`. Missing configuration fails with exit code 1; it never skips and claims success.

Prepare three **private test repositories under the same owner**, all authorized for the Silo GitHub App. The `DENIED` repository is authorized to the App but deliberately excluded from the VM's selected subset. Enable issues in the write repository. Supply the App's user access token, not a personal access token or installation token. The App needs repository Contents and Issues write permission for the tested workflows, plus the production GitHub permissions documented in the service README.

Provide these through the process environment or a private secret manager. Do not place credentials in command arguments, source files, shell history, or committed configuration:

- `SILO_GITHUB_TEST_CONFIRM=private-test-repositories`
- `SILO_GITHUB_CLIENT_ID`, `SILO_GITHUB_CLIENT_SECRET`, `SILO_GITHUB_TEST_USER_TOKEN`
- `SILO_GITHUB_TEST_READ_REPO`, `SILO_GITHUB_TEST_READ_REPO_ID`
- `SILO_GITHUB_TEST_WRITE_REPO`, `SILO_GITHUB_TEST_WRITE_REPO_ID`
- `SILO_GITHUB_TEST_DENIED_REPO`, `SILO_GITHUB_TEST_DENIED_REPO_ID`

Repository values are exact `owner/name` strings; IDs are GitHub's numeric repository IDs. Preflight verifies all names, IDs, private visibility, and ownership before creating tokens or changing an issue.

From the repository root:

```sh
npm --prefix services/github-auth run build
node services/github-auth/dist/test/live/authorized-github.js
```

The service regression checks scoped REST and GraphQL reads, denied repository access, node-based issue mutations with write permission, rejection of the same mutation with read permission, All repositories, and individual token revocation preserving the parent and sibling credentials. It creates one uniquely named issue **only in the explicit write test repository**, then closes it during cleanup. The closed issue remains as a test record. Every created child token is revoked before exit; the parent login remains intact.

For the complete VM workflow, also supply `SILO_TEST_MSB` (signed bundled MicroSandbox executable) and `SILO_TEST_LIBKRUNFW` (bundled library), then run:

```sh
node services/github-auth/dist/test/live/authorized-github.js --vm
```

This invokes the ignored native `github_authenticated_guest_workflow` regression using the newly scoped tokens. It exercises real guest Git, Git LFS, `gh`, and live access changes. Only scoped tokens enter the native test's host environment; the App secret and parent login are omitted. Native output is suppressed to prevent credential exposure. A failed native test gives a generic failure rather than printing raw subprocess output. The native test uses a disposable VM and test branch in the explicit write repository; inspect that repository if cleanup cannot be confirmed.

Requests are not automatically replayed. A timeout during a mutation can leave the test issue or test branch behind. A timeout during token issuance can leave a child token whose value was never received. Cleanup failures fail the run and require inspecting the named test repository and revoking test access. These are real integration limits, not a passing result.

The harness prints fixed check labels and HTTP status codes only. Do not enable HTTP debug logging around a credential-bearing run. A passing service-only run proves the token service checks, not VM transport or desktop OAuth. A passing `--vm` run adds VM transport coverage; it still does not test the desktop browser callback UI or every `gh` command.

References: [GitHub GraphQL issue mutations](https://docs.github.com/en/graphql/reference/issues), [scoped user token API](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token).
