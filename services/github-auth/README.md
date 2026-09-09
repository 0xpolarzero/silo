# Silo GitHub authorization service

A stateless TypeScript service using `@octokit/oauth-methods`. The Silo native
backend calls this service; neither the frontend nor VMs receive its App secret.
The service does not proxy repository traffic and does not store user tokens.

## Run and deploy

Use Node 24 or newer. Register a **production Silo GitHub App**, enable expiring
user tokens, and register `http://127.0.0.1/github/callback` as the desktop callback
(with GitHub's documented loopback-port behavior). Native login uses state and
PKCE. Configure App repository permissions for the supported GitHub operations;
GitHub remains the authority. Do not request unrelated account administration.

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

## References

- [GitHub scoped tokens](https://docs.github.com/en/rest/apps/apps#create-a-scoped-access-token)
- [Octokit OAuth methods](https://github.com/octokit/oauth-methods.js)
- [GitHub App OAuth and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

Restricted-token revocation uses GitHub’s individual `DELETE /applications/{client_id}/token` endpoint. Disconnecting the whole account uses the separate authorization revocation endpoint. The tests verify these exact endpoints; a live proof that revoking a scoped child preserves its parent authorization still requires a configured App.
