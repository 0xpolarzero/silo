# Silo GitHub authorization service

A stateless TypeScript service using `@octokit/oauth-methods`. The Silo native
backend calls this service; neither the frontend nor VMs receive its App secret.
The service does not proxy repository traffic and does not store user tokens.

## Run and deploy

Use Node 24 or newer. Reuse the existing **microsandbox-workspaces** GitHub App
(client ID `Iv23liEjp3VnGe0sw2LU`); creating another registration is unnecessary.
Enable expiring user tokens, create its server-side client secret if missing, and register `http://127.0.0.1/github/callback` as the desktop callback
(with GitHub's documented loopback-port behavior). Native login uses state and
PKCE. Configure App repository permissions for the supported GitHub operations;
GitHub remains the authority. Set every organization and account permission to
**None**. Silo supports repository workflows, not organization or account
administration: selecting repository IDs does not restrict an organization-level
permission. Grant only repository permissions in the production App; both the
read-only and change-enabled tokens inherit that boundary.

Supply `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` through the hosting platform's
secret manager. Never put the secret in source, build arguments, desktop bundles,
access logs or request tracing. Set `PORT` if needed; default is 8787. The default
bind address is localhost; set `HOST` explicitly for the hosting platform.

```sh
npm ci
npm test
npm run build
npm start
```

Deploy behind HTTPS with request limits/rate limiting and request-body/header
logging disabled. Do not expose the plain HTTP listener publicly. The process caps
request bodies at 64 KiB and concurrent requests at 32, and uses bounded upstream
timeouts. Set desktop build configuration `SILO_GITHUB_SERVICE_URL` to the real
HTTPS origin, `SILO_GITHUB_CLIENT_ID` to the same App ID string, and
`SILO_GITHUB_APP_SLUG` to its App slug. No production domain or credentials are
included here. Deployment requires those real account/infrastructure settings.

## Container package

The multi-stage `Dockerfile` uses the official Node 24 Debian slim image, installs
locked dependencies, and copies only compiled production code and production
dependencies into the final stage. It runs as the unprivileged `node` user.
The `.dockerignore` admits only source/build metadata: environment files, private
keys, local dependencies, tests, logs, and artifacts never enter the build context.
No credentials are build arguments or image layers.

From the repository root:

```sh
docker build --tag silo-github-auth:local services/github-auth
```

Configure `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as runtime secrets in the
chosen host. The image listens on `0.0.0.0:8787` by default, honors `PORT`, and
handles SIGTERM/SIGINT directly through Node. Keep the service behind the host's
HTTPS endpoint. Run with a read-only filesystem, dropped capabilities, and resource
limits where the host supports them; the service requires no writable data volume.
No hosting provider is selected and no deployment is performed by this package.

Use `GET /healthz` for the platform health check (the existing `/health` also
works). It returns only `{"status":"ok"}` without reading credentials or calling
GitHub, even when all 32 operation slots are occupied. It checks process readiness,
not GitHub authorization. Every response carries no-store and nosniff headers.

`npm test` includes real loopback HTTP tests for routing, browser-origin rejection,
known-length and chunked body limits, overload retry metadata, and health during
overload. It requires permission to listen on localhost and never contacts GitHub.

Local verification on 2026-09-09: all 30 service/HTTP tests passed; the Docker image
built successfully and its actual entry point passed a health smoke test as UID
1000 with a read-only filesystem, dropped capabilities, and no external network.
The test container used synthetic credentials and was removed afterward. This
proves packaging and HTTP behavior, not authenticated GitHub operations or a
hosted deployment.

The packaging follows the official [Node image guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)
and [Docker multi-stage build documentation](https://docs.docker.com/build/building/multi-stage/).

## App registration

GitHub supports an [App registration manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
A deployable manifest requires Silo's real homepage and registration callback; the
callback must exchange GitHub's temporary code for App credentials and keep those
credentials on the service host. Those deployment URLs and the registration
callback are not configured here, so this repository does not include a pretend
production manifest. Manual App registration can supply the same settings.

Review the complete repository permission set on the existing App, with all
organization/account permissions disabled. GitHub's granted permissions determine
which `gh` operations work; Silo does not maintain a command-name allowlist.
Before issuing any restricted token, the service validates every granted
installation permission against GitHub's repository permission category. Any
organization, user, enterprise, or unknown permission rejects the operation
before token creation. This checks the App registration, not `gh` command names.
It applies equally to read-only, change-enabled, selected, and all-repository
requests. Unknown future permissions require a category review before being added;
they are never silently inherited. The existing GitHub App can be reused only
when its permissions satisfy this check.

The names come from GitHub's [App permission schema](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
and official [repository permission parameter table](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#repository-permissions),
cross-checked against its [GitHub App permission categories](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
on 2026-09-09. Write-only `workflows` and `codespaces_secrets` are omitted from
read-only grants because requesting `read` for either is invalid.

Repository operations requiring an ungranted permission fail with GitHub's normal
permission error. Account and organization administration are outside this App's
authority even when **Allow GitHub changes** is enabled.

## Native API

All routes require JSON POST and return no-store JSON. Browser-origin requests
are rejected. GitHub errors are reduced to safe messages, never echoed raw.

| Route | Input | Success |
| --- | --- | --- |
| `/v1/oauth/exchange` | `code`, `codeVerifier`, `redirectUri` | `accessToken`, `refreshToken`, `expiresIn`, `refreshTokenExpiresIn` |
| `/v1/oauth/refresh` | `refreshToken` | Same token response |
| `/v1/oauth/revoke` | `accessToken` | `revoked: true` |
| `/v1/tokens/scope` | `accessToken`, `ownerId`, `repositoryIds`, `allowChanges`, optional `allRepositories` | `accessToken`, `expiresAt` |
| `/v1/tokens/revoke` | `accessToken` (one restricted token) | `revoked: true` |

Selected mode requires 1–500 unique positive repository IDs. All mode requires an
empty ID list and an explicit `allRepositories: true`. It scopes to that owner and
App installation, not all GitHub accounts. The service reads the App installation's
actual permissions; read-only scope lowers write/admin permissions to read and
omits the write-only `workflows` permission. Change-enabled scope preserves the
App installation's granted levels. This follows the [scoped-token permission
schema](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token). GitHub checks
the repositories themselves. Expired, suspended and unauthorized access fails.

The Octokit exchange helper currently lacks a dedicated PKCE option; the service
passes the official `code_verifier` parameter using Octokit request defaults.
A regression test checks the actual outgoing request body. No custom OAuth/token
implementation replaces Octokit.

## Rate limits and retries

The service makes one upstream attempt per operation. The native app owns the
retry schedule, so obsolete settings can cancel pending retries. The service
never automatically repeats token creation, code exchange, or refresh after an
ambiguous timeout or server failure: GitHub may already have completed it.

Confirmed GitHub rate limits return HTTP 429 with `code: "rate_limited"`,
`retryable: true`, `retryAfterSeconds`, and `Retry-After`. A GitHub 403 is classified
as a limit only when its headers or documented rate-limit message identify one;
ordinary permission failures remain 403 and are not automatically retried.
Validated `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers are preserved.
The delay honors both `Retry-After` and an exhausted primary reset, using the
longer wait. A secondary limit without timing information waits at least 60
seconds. The native scheduler increases delays with jitter for repeated failures
and stops after its retry budget; this service does not sleep or retain tokens.

A transport/server failure returns 502 with `code: "upstream_error"` and
`retryable: false` for token writes. It sets `retryable: true` only if the failed
step was a safe installation read or idempotent revocation. Local overload returns
503 with `code: "service_busy"`, `retryable: true`, and a five-second `Retry-After`;
no upstream request has started. No raw upstream message or arbitrary header is
returned. These rules do not replay Git pushes or guest API requests.

This follows GitHub's [rate-limit response rules](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [bounded exponential retry guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## References

- [GitHub scoped tokens](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token)
- [Octokit OAuth methods](https://github.com/octokit/oauth-methods.js)
- [GitHub App OAuth and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

Restricted-token revocation uses GitHub’s individual `DELETE /applications/{client_id}/token` endpoint. Disconnecting the whole account uses the separate authorization revocation endpoint. The tests verify these exact endpoints; a live proof that revoking a scoped child preserves its parent authorization still requires a configured App.
