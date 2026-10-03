# Workflows micro-review

Scope: `.github/workflows/`, covering correctness, supply-chain pinning, secret exposure, and permission scopes. Read-only source review; no builds, tests, publishing, or credential access. Previously reported findings in the two main-checkout reviews and local pass-three reviews are excluded.

## WORKFLOWS-1: P2 — Pinned QEMU action executes an unpinned privileged image

- **File:line:** `.github/workflows/guest-image.yml:60`.
- **Trigger:** Run guest-image publication on a runner without a cached binfmt image after the upstream `latest` tag changes.
- **Evidence:** The workflow pins `docker/setup-qemu-action` to commit `99012661954931238ded8c8b007157a8430204e1` but supplies no `image` input. That exact commit's [action metadata](https://raw.githubusercontent.com/docker/setup-qemu-action/99012661954931238ded8c8b007157a8430204e1/action.yml) defaults to `docker.io/tonistiigi/binfmt:latest`. Its [implementation](https://raw.githubusercontent.com/docker/setup-qemu-action/99012661954931238ded8c8b007157a8430204e1/src/main.ts) pulls this image and runs it with `--privileged` for installation and inspection. The publishing job has `contents: write` and `packages: write` at lines 38–40; checkout precedes QEMU and registry login follows it.
- **Consequence:** Identical repository and action commits can execute different upstream binaries with host privileges in a publication job. The action SHA does not pin this executable dependency. A compromised image has privileged access to the publication runner; no compromise or token extraction was attempted or observed.
- **Suggested fix:** Set the supported `image` input to a reviewed `docker.io/tonistiigi/binfmt@sha256:…` digest and update it explicitly. Restrict installed platforms to those needed by the build.
- **Test that would catch it:** Extend workflow pin validation to reject every QEMU setup step whose effective `image` input lacks a full SHA-256 digest, including omission of the input. Verify changing only the upstream tag cannot change the selected image identity.

## WORKFLOWS-2: P2 — Registry lookup failures bypass the image overwrite guard

- **File:line:** `.github/workflows/guest-image.yml:71` (subsequent writes at lines 84–87).
- **Trigger:** A previous publication pushed an architecture image but failed before creating the GitHub release. Retry that version while the registry manifest lookup returns a transient network/server error, then let the registry recover before the push.
- **Evidence:** The architecture guard puts `docker manifest inspect "$IMAGE-$arch"` directly inside `if`, discards both output streams, and proceeds on every nonzero result. Docker's [manifest inspector implementation](https://github.com/docker/cli/blob/master/cli/command/manifest/inspect.go) returns registry errors, not just missing-manifest errors. The later steps rebuild both architectures and push the same versioned tags. `docs/SiloUI-GUEST-IMAGES.md` lines 31–34 explicitly require recovery of exact artifacts after partial publication and prohibit rebuilding over existing architecture tags. The earlier GitHub-release guard cannot detect this partial-publication case because the release is created last, at line 110.
- **Consequence:** A failed lookup is treated as proof that an architecture tag is absent. The retry can replace an already published architecture with newly built bytes, violating the workflow's version-preservation guard and the documented recovery contract. This is a source-confirmed failure path, not an executed registry overwrite.
- **Suggested fix:** Permit publication only after a confirmed missing-manifest response. Fail on authentication, transport, throttling, and server errors; retain a sanitized diagnostic. Apply the same distinction to the release-existence check at line 56 so API failures cannot authorize publication.
- **Test that would catch it:** Exercise the guard with recorded responses for existing manifest, confirmed absence, unauthorized request, timeout, and HTTP 500. Only confirmed absence may reach build/push; a partial-publication fixture with an existing architecture and a failed lookup must stop before any write.
