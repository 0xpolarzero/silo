# E2B pinned-release source mapping

Date: 2026-09-23. **Result: the pinned API and orchestrator artifacts cannot
yet be tied to an exact public source commit or to the D1–D3 incident
processes.** Current binary identity is stronger than source identity; neither
identifies the effective checkpoint flags at the historical requests. This is
insufficient for an incident-attributed upstream issue.

## The three identities

| Identity | What is established | What is not established |
| --- | --- | --- |
| Current artifacts | The [provenance audit](e2b-provenance-audit-2026-09-23.md) reports current API OCI digest `sha256:e131ee5abc41104eb37b8fcac9bcc5ff2b76adc401bf358dc368a3c5753f5493`, an orchestrator binary SHA-256 `e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`, and a matching public orchestrator SHA-256 sidecar. The local read-only API binary copy hashes to `079f93ffbd99602c909406c03ea70ce4c8e08d6780bbb529bf6f437953a1886d`. | An OCI digest for the `tools` service is **not** the orchestrator binary digest. The API binary copy's relationship to the reported API OCI digest was not independently checked in this task. Current artifacts need an incident request/process link. |
| Release labels | `go version -m` on the local binary copies reports Go 1.26.8, Linux/ARM64, API linker values `main.commitSHA=908833e4c1`, `serviceVersion=0.14.202609170000-908833e4c12`; orchestrator values `main.commitSHA=59497eb913`, `Version=0.16.202609130627-59497eb9134`. These agree with the inspected Compose `.env` selectors. | Neither binary embeds `vcs.revision` or a full source commit. A linker string and immutable artifact tag identify a release label, not the source tree contents or effective runtime configuration. |
| Public source | The Compose acquisition revision [`a065a4d…`](https://github.com/e2b-dev/runtime/commit/a065a4ddb3f2c6a4149634d9acb14b62f65839ac) and its `RUNTIME_COMMIT` [`7278c2a…`](https://github.com/e2b-dev/runtime/commit/7278c2a380767c9989da73cf4c04b1af1b32da18) resolve in the public mirror. `RUNTIME_COMMIT` is the Embed checkout selection in `.env`; that public commit changes Embed smoke tests and docs. | Neither revision is demonstrated to be the API or orchestrator release source. The short release suffixes `59497eb9134` and `908833e4c12` each returned 404 at the public runtime commit URL on 2026-09-23. A 404 does not prove there is no corresponding Copybara-exported commit with a different SHA. |

E2B's [release procedure](https://github.com/e2b-dev/runtime/blob/main/docs/RELEASING.md)
states that the public repository is a read-only Copybara mirror, while
component release tags and publishing are performed in E2B's internal
monorepo. Package tags do not appear in that public mirror. The procedure
describes versioned, create-only binary objects with adjacent SHA-256
sidecars. That supports the artifact-label match but supplies no public
tag-to-exported-commit mapping. The presence of GitHub's general releases page
does not supply a package-specific tag for these two pinned versions.

## Read-only checks and exact public URLs

The following commands were run on the existing **local copies**. They did
not query or mutate either VM. The paths are ignored verification evidence.

```sh
shasum -a 256 \
  app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/binaries/api-arm64 \
  app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/binaries/orchestrator-arm64
go version -m app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/binaries/api-arm64
go version -m app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/binaries/orchestrator-arm64
```

The full module lists were examined only locally; the relevant build settings
are `CGO_ENABLED=0` for API and `CGO_ENABLED=1` for orchestrator, both
`GOOS=linux`, `GOARCH=arm64`, with the linker labels above. The captured public
source build and the release orchestrator each list 241 dependencies, but two
resolved versions differ: `github.com/gofrs/uuid/v5` is `v5.5.1` versus
`v5.4.0`, and `github.com/sumup/typeid` is `v0.8.0` versus `v0.7.0`
(captured versus release). This positively rejects the captured source and
module set as an **exact reproduction** of the pinned binary. It does not
show which code line differs or whether a dependency caused D1–D3.

These exact public commit requests were read-only web checks on 2026-09-23:

```text
https://github.com/e2b-dev/runtime/commit/59497eb9134   -> 404
https://github.com/e2b-dev/runtime/commit/908833e4c12   -> 404
https://github.com/e2b-dev/runtime/commit/7278c2a380767c9989da73cf4c04b1af1b32da18 -> resolves
https://github.com/e2b-dev/runtime/commit/a065a4ddb3f2c6a4149634d9acb14b62f65839ac -> resolves
```

The official release procedure gives these public sidecar locations for the
selected versions; the earlier provenance audit reports their checksums match
the copied orchestrator and envd binaries. This task did not independently
fetch them because the web fetch surface could not open the object URLs and
the shell had no DNS access:

```text
https://storage.googleapis.com/e2b-artifact-binaries/orchestrator/v0.16.202609130627-59497eb9134/orchestrator.sha256
https://storage.googleapis.com/e2b-artifact-binaries/envd/v0.9.202609130627-59497eb9134/envd.sha256
```

Read-only `git ls-remote` and `gh api` probes from this sandbox failed at DNS
resolution; they yielded no tag or commit evidence. The public GitHub 404s and
the official release procedure, rather than those failed shell probes, support
the source-mapping limit.

## Checkpoint source and flag implications

The local [lifecycle source audit](e2b-lifecycle-source-audit-2026-09-23.md)
and [D1 controlled result](e2b-d1-post-capture-repro-2026-09-23.md) concern
the captured public tree with 2,568-file manifest SHA-256
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
Its defaults for `use-sync-wp`, `in-place-checkpoint`, and
`peer-to-peer-async-checkpoint` are false. Defaults are **not** the selected
values for a sandbox or request. The current pinned orchestrator binary's
symbols/call targets structurally match the fresh checkpoint path, including
`snapshotAndCacheSandbox`, `ResumeSandbox`, `runCheckpointUpload`, and source
stop calls, but a binary containing that path does not prove that any D1
request selected it. No incident-linked effective flag evaluation was found
in the preserved evidence scan.

The historical D1 summary calls its error a fresh-resume allocation failure,
but the manually assembled summary is not a syscall/errno trace. The
source-built exact-ID hook ran before `ResumeSandbox`; its result is evidence
for that candidate's post-capture failure boundary only. API routing, the
checkpoint branch, source process identity and selected flags for the
historical request remain unproven.

## Falsifiable path to an attributable report

1. Obtain E2B's release build record for
   `orchestrator-v0.16.202609130627-59497eb9134` and
   `api-v0.14.202609170000-908833e4c12`: internal full commit SHA, exported
   Copybara commit or a reproducible source archive digest, dependency lock
   files, build inputs, and the binary/image digest they produced. A
   tag-to-public-export mapping must be supplied or independently verified;
   a short suffix match is insufficient.
2. Link each D1 incident request/build ID to the exact API and orchestrator
   process start time and artifact digest, then capture that request's SDK
   handler, gRPC result, `use-sync-wp` and `in-place-checkpoint` evaluations,
   Firecracker compatibility, and the actual allocator error. Existing
   current-state hashes do not establish what served a prior request.
3. With those identities fixed, compare the relevant checkpoint/API files
   against the captured tree or run an explicitly labeled source-built
   reproduction. If the source/export mapping cannot be obtained, report only
   the source-built candidate behavior and its preserved oracles, without
   claiming the historical D1 release shares its cause.

**Next action:** request the two release build records and Copybara export
mapping from E2B, keyed by the artifact digests above.
