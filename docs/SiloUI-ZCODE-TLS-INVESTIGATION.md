# SSH coding-agent TLS regression

## Problem and root cause

ZCode 3.11.2 connects to a Silo sandbox over SSH, but its provider request fails
with `MODEL_TLS_VALIDATION_FAILED`, caused by `SELF_SIGNED_CERT_IN_CHAIN`.
The server inherits `NODE_EXTRA_CA_CERTS=/.msb/tls/ca.pem`. Its real environment
sanitizer removes that variable before spawning the agent. It retains the path
only in a JSON blob for tool subprocesses. The child therefore cannot validate
MicroSandbox-issued certificates even though tools and the parent can.

The original suspicion of an explicit provider CA override was not the active
failure path in the reported session. It remains a separate covered failure case.

## Silo fix

Silo's bundled MicroSandbox now intercepts TLS only for destinations matching an
assigned secret's allowed hosts. Unrelated destinations retain their actual
server certificate. The decision uses the live secret snapshot and the same
host-pattern matching used for substitution. Exact, wildcard, and `*` assignments
are covered; an explicit `*` still requires interception everywhere.

The existing network policy runs before this decision. Explicit TLS bypasses
retain their previous semantics. Intercepted destinations still enforce upstream
certificate verification, SNI/Host identity, and secret-substitution restrictions.
Both direct and intercepted proxy connections close on a secret policy change;
reconnection evaluates the current policy. No domain list is learned from TLS
failures, and certificate verification is never disabled.

This is a Silo-specific runtime policy, implemented in the existing vendor patch
and pinned through `runtime-inputs.json`. It also covers existing saved VM
configurations when they next start with the updated runtime. It does not
implicitly restart running VMs.

### Why this fix

Preserving ambient CA trust is the correct upstream ZCode fix for its child-launch
bug. The fast test verifies that candidate. Silo does not own ZCode's server,
should not rewrite installed third-party bundles, and cannot force arbitrary
clients to retain CA environment variables or accept interception.

Silo needs interception to inject host-held credentials. Intercepting unrelated
traffic adds a trust requirement without providing that capability. Limiting
interception to secret destinations fixes the general compatibility issue without
hardcoding `*.z.ai` or requiring users to configure exceptions. It is consistent
with Silo's existing policy of forwarding public placeholders unchanged to
unrelated hosts (see `SiloUI-AGENT-PLACEHOLDER-STALL.md`).

A client using a secret assigned to its provider still needs to trust the sandbox
CA. That case cannot safely be solved by silently bypassing secret injection.
This change intentionally stops HTTP inspection of encrypted requests to
non-secret destinations; network policy there is enforced using the existing
connection and SNI checks.

## Reproduction assets and fidelity

- Reported ZCode: 3.11.2, build `89817f5b`.
- Actual local agent bundle, also reported byte-identical remotely: SHA-256
  `e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8`.
- User-supplied server excerpt claims source-bundle SHA-256
  `9cc214d482b660e148ff55f9780b182ce2874e3d24bfc1a62d362bc3ff71dd13`.
  The full remote server was not supplied, so that provenance cannot be verified
  against the complete bundle here.
- Reviewed excerpt, retained with original line gutters and LF newlines: SHA-256
  `1c202392dde305b15b875a9d458ba59136354ebcc118eb9854695caf11476aee`.
  The loader checks this hash before evaluating it.

The fast test executes the extracted server environment builders and actual spawn
statement. Fresh children execute functions extracted from the installed ZCode
provider transport and TLS error normalizer. They perform real verified TLS
handshakes with a generated local CA. It checks original failure, two trust
propagation candidates, tool trust, broker-credential exclusion, and explicit CA
replacement. It makes no provider calls and requires no account credentials.

The live test creates an isolated MicroSandbox VM using the bundled Ubuntu 24.04
image, TLS interception enabled, empty bypass list, and a synthetic GitHub secret
restricted to the production GitHub hosts. It connects through `msb ssh serve`,
starts Linux Node 22.16.0, and executes those same server builders, spawn statement,
and actual provider transport. It sends unauthenticated requests to api.z.ai and
api.github.com. Any HTTP response proves TLS succeeded; no model completion is
requested. The baseline must reproduce the exact cause chain. The fixed runtime
must preserve ordinary provider TLS while still intercepting GitHub. Moving the
secret to api.z.ai and then removing it must update both routes without VM restart.

This exercises the real VM, SSH listener, runtime TLS proxy, Linux Node, child
launch boundary, and provider transport. The complete ZCode desktop/server
protocol, OAuth, and model turn are not launched. Coverage settings, workspace
identity, and process-group inputs are test fixtures. The tool passthrough blob
is supplied explicitly because its attachment point is outside the provided
server excerpt. Live verification on this Apple Silicon host uses Linux ARM64;
the original incident used Linux x64. These are the remaining fidelity limits.

## Verified results, 2026-09-15

The same standalone guest probe ran against the old and rebuilt runtime in
separate disposable VMs. Both used Node 22.16.0 and guest kernel 6.12.99.

| Runtime and live assignment | api.z.ai, unchanged ZCode child | api.github.com certificate |
| --- | --- | --- |
| Previous runtime, GitHub hosts | SELF_SIGNED_CERT_IN_CHAIN | MicroSandbox |
| Fixed runtime, GitHub hosts | HTTP 401, real Sectigo certificate | MicroSandbox |
| Fixed runtime, secret moved to api.z.ai | SELF_SIGNED_CERT_IN_CHAIN | Real Sectigo |
| Fixed runtime, secret removed | HTTP 401, real Sectigo certificate | Real Sectigo |

Restoring NODE_EXTRA_CA_CERTS alone before child startup succeeds in both runtimes.
No provider-specific CA replacement, TLS bypass setting, invalid-certificate
acceptance, or provider credentials were used for this control.

- Real-VM failure and recovery checks: passed, including live host reassignment
  and removal without VM restart; successful disposable VMs stopped and removed.
- MicroSandbox network suite: 541 unit tests and 1 module integration test passed.
- Fast ZCode TLS/launch suite: 2 tests passed.
- Runtime staging: 12 tests passed. Release tooling: 31 tests passed.
- Final vendor patch applies cleanly to the pinned source; resulting changed
  source files match the files used to build the tested runtime. Runtime input
  preflight and patch digest verification passed.

Ignored evidence lives under `app/SiloUI/src-tauri/target/verification/zcode-tls/`:
`baseline-final/result.json`, `fixed-final/result.json`,
`fixed-final/changed-host.json`, `fixed-final/removed-secret.json`,
`network-tests-final.log`, `fast-tests.log`, and `build-final.log`.
An initial fixed-runtime certificate probe timed out; its output is retained in
`fixed/commands.log`. The same runtime subsequently passed with and without debug
logging. The timeout cause was not established; the opt-in live test depends on
public endpoint availability and reports such failures rather than masking them.

The inspected executable was the test-signed
`target/verification/zcode-tls/msb-fixed`, not an installed Silo app bundle. No
existing user VM, installed app, or third-party ZCode binary was modified.

## Running the tests

Fast reproduction (Node 24, OpenSSL, and frontend dependencies):

```sh
SILO_TEST_ZCODE_BUNDLE=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs node --test app/SiloUI/scripts/zcode-tls.test.mjs
```

For the live test, create an ignored assets directory with the verified official
Linux Node 22.16.0 executable named `node`, matching the guest architecture.
Generate the standalone guest script from the matching installed ZCode bundle:

```sh
node app/SiloUI/scripts/tls/build-live-probe.mjs /absolute/path/to/zcode.cjs /absolute/path/to/assets/probe.cjs
```

Node archive source: https://nodejs.org/dist/v22.16.0/ . Verify its SHA-256 against
that release's SHASUMS256.txt before extracting `bin/node`. The tested Linux ARM64
archive SHA-256 is
`eab80cb88f8fda1e65f5e8d0420c9809bdb320b03fd34976ab7161b6e703b910`.

Run with a signed baseline or fixed MicroSandbox binary, its matching libkrunfw,
and a fresh output directory. macOS test binaries require the hypervisor
entitlement; use test-only copies, not an installed user's executable.

```sh
SILO_RUN_ZCODE_TLS_LIVE=1 python3 app/SiloUI/scripts/test-zcode-tls-live.py \
  --msb /absolute/path/to/msb \
  --library /absolute/path/to/libkrunfw \
  --guest-image app/SiloUI/src-tauri/runtime/guest-image \
  --assets /absolute/path/to/assets \
  --output app/SiloUI/src-tauri/target/verification/zcode-tls/fixed \
  --expect fixed
```

Use `--expect broken` with the previous runtime for the failure reproduction.
The test never accesses existing Silo VM state. It keeps failure evidence,
gracefully stops its VM, and removes successful disposable VM state. It requires
hypervisor and network access and is deliberately outside ordinary unit tests.

Apply the runtime patch to the pinned source before running Rust regressions:

```sh
cargo +1.94.0 test --locked --manifest-path /path/to/patched-source/Cargo.toml -p microsandbox-network
npm --prefix app/SiloUI test -- src/test/microsandbox-runtime.test.ts
npm --prefix app/SiloUI run test:release
```

## Primary sources

- [Node CA startup and explicit-CA semantics](https://nodejs.org/download/release/v22.4.0/docs/api/cli.html#node_extra_ca_certsfile).
- [MicroSandbox TLS configuration](https://docs.rs/microsandbox-network/latest/microsandbox_network/tls/struct.TlsConfig.html).
- Pinned MicroSandbox source `5eca4de8bf233e57f114140f8c076ea8c96f21ab`:
  `crates/network/lib/tls/proxy.rs`, `tls/state.rs`, `secrets/handle.rs`, and
  `packages/microsandbox-types/rust/lib/domain.rs`.
