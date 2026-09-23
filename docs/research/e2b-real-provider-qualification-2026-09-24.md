# E2B real-provider qualification (Gate C)

Date: 2026-09-24. Scope: real GitHub behavior against a user-authorized
disposable private repository
`0xpolarzero/silo-e2b-provider-qualification`, executed from the Mac with
`gh` + git + git-lfs. This complements the synthetic fixture matrix; it does
not exercise the guest-side broker path for real hosts. Full report (private,
credential-free): `deployments/diagnostic-d1/evidence/gate-c-real-provider/report.json`
(runs `579c97ec`, `c06a34c6`). Script: tracked
[`experiments/e2b-local/real-provider-qualification.py`](../../experiments/e2b-local/real-provider-qualification.py).

## Results (9/9 passed)

| Case | Outcome |
| --- | --- |
| Clone (incl. true empty-repo clone), identity pinned | smart HTTP; `git credential fill` returned the gh token (digest-verified match) for github.com |
| Unicode commit push | commit `346357b…` verified server-side via REST commits+contents APIs; base64-decoded content byte-identical |
| Second clone | index (`git ls-files -s`) and HEAD SHAs identical; per-file bytes identical |
| LFS 2 MiB round trip | pointer `sha256:72067ead…` matches local hash; fresh clone re-downloaded with SHA-256 equality |
| gh REST | `GET /repos/…` → private repo visible |
| GraphQL | `{ viewer { login } }` succeeds against real GitHub — the PoC broker's GraphQL rejection remains a documented product gap |
| Denied: foreign-repo push | 403 (octocat/Hello-World); branch absent (404) |
| Denied: foreign-repo write | PUT contents → 404 (failing call only) |
| Denied: nonexistent repo | 404 / ls-remote denied |

## Credential-host accounting (CONNECT-tunnel recorder, hostname-only)

The credential reached exactly: `github.com` (git smart HTTP, LFS batch
origin after a 307), `lfs.github.com` (LFS batch API), `api.github.com`
(REST/GraphQL Bearer). It did **not** reach the LFS object hosts
(`github-cloud.s3.amazonaws.com`, `github-cloud.githubusercontent.com`):
those use presigned URLs, corroborated by the upload succeeding while AWS
rejects presigned requests that carry an Authorization header. Token scopes:
`gist, read:org, repo`; referenced in all artifacts only by SHA-256 digest
`ee406def…`.

## Explicit limits

Revocation-after-restore with a rotated real token is blocked (no second
token exists; rotating the user's session token would break their login).
Only the gh OAuth token is qualified — no PAT/fine-grained/App variants. No
MITM proof of header absence beyond the CONNECT recorder + presigned
behavior. SSH transport, signing and uploads.github.com untested. The
broad-scope token was constrained by discipline (only the disposable repo
was touched); a narrowly scoped grant remains the right production posture.
GraphQL broker policy is a product decision, not resolved here.
