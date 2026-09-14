# Secret placeholders in agent requests

2026-09-14.

## Failure and reproduction

After a tool printed the public guest GH_TOKEN placeholder, the agent included it in its next model request. The runtime treated the literal as a secret-policy violation outside the GitHub allowlist and closed the TLS connection. Retries carried the same conversation history and failed again. This diagnosis does not establish the cause of the separate GitHub authentication failure.

The deterministic regression sends fragmented JSON tool results containing GitHub and ordinary secret placeholders to two provider hostnames, using synthetic credentials and the production SecretsHandle configuration boundary. Both cases failed with the legacy blocking policy and pass with the correction. No provider requests or real credentials are used.

## Implementation

The bundled runtime normalizes boot-time secret policies to passthrough at SecretsHandle::new. This covers existing saved VM configurations as well as newly created VMs. Per-secret legacy blocking overrides are cleared. Unmatched placeholders travel unchanged; allowed-host and TLS identity checks still control real-value substitution. Live rotation and host changes retain this behavior. Ordinary network policy, malformed request handling, and GitHub repository authorization remain enforced.

The relevant primary source is the `crates/network/lib/secrets/handle.rs` section of `app/SiloUI/patches/microsandbox-create-stopped-0.6.17.patch`. The upstream handler already supports passthrough; this change selects it at Silo's runtime boundary rather than weakening the credential allowlist.

## Verification and rollout

With Rust 1.94.0, `cargo test -p microsandbox-network --lib --offline` passed all 538 tests in a fresh source extraction with Silo's complete patch. Local socket permission was required for loopback tests. New tests cover fragmented tool results for two provider hostnames, GitHub and user secret placeholders, migration of explicit legacy blocking, live rotation and allowed-host replacement, and forwarding without substitution over plaintext.

These are deterministic runtime tests, not proof of installed-app or live-provider recovery. Existing VMs must restart using the updated runtime. Remote computers must also receive the updated runtime; updating only the desktop client cannot change a running remote process. No user VM was stopped during this verification.
