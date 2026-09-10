# macOS VM library-loading proof

Tested on 10 September 2026, macOS 26.5 (25F71), Apple Silicon.

## Finding

Apple's library constraints work with ad-hoc signing on this machine. A hardened
`msb` can load the exact bundled `libkrunfw` identified by its code-directory hash
and reject other non-system libraries at load time. No Developer ID certificate
was used. This is OS enforcement, not a Silo checksum check before launch.

The standard library-validation exception is still present in the test executable,
but an embedded library constraint replaces unrestricted loading with an exact
code-hash rule. Apple explicitly describes this combination as a use for library
constraints. Hardened runtime remains enabled. Operating-system libraries are
exempt from library constraints.

## Observed behavior

| Test | Result |
| --- | --- |
| Standard validation with an ad-hoc library | Rejected for lack of a matching Apple Team ID. |
| Broad exception alone | Harmless substitute library executes, demonstrating the missing barrier. |
| Exception plus exact code-hash constraint | Approved library executes. |
| Different library with the same signing identifier | Rejected by the library constraint before its initializer executes. |
| Replacement at the approved pathname | Rejected; names and paths do not satisfy the hash constraint. |
| Approved library copied to another path | Accepted; the rule approves code, not a path. |
| Replaced indirect dependency | Rejected even though the directly loaded parent library is approved. |
| Unsigned substitute | Rejected. |
| Modified approved library retaining its old signature | Signature verification fails; macOS kills the test loader for an invalid code page before its initializer executes. |
| Loader copied and re-signed without its constraint | Substitute executes, demonstrating the whole-executable limitation. |

The real runtime test copied Silo's optimized `msb` and bundled engine into an
isolated temporary directory. With the exact engine hash constrained, it created
and booted a one-CPU, 512 MB VM from Silo's bundled image, executed a guest command,
and stopped. An alternate engine path was rejected with an explicit library-load
constraint error. Replacing the actual engine path with a different library using
the original signing identifier also failed. Restoring the approved engine allowed
the VM to boot and execute again. The disposable VM was stopped afterward.

The original Silo app, its running `dev` sandbox, and release signing settings
were not changed by these experiments. Replacement libraries only print a test
marker; they contain no malicious payload. Initializer markers use unbuffered
output so a process crash cannot conceal buffered output.

## Reproduce

From the repository root, with a built Apple Silicon release bundle:

```sh
python3 app/SiloUI/scripts/test-macos-library-constraints.py \
  --runtime-bundle app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app \
  --guest-image app/SiloUI/src-tauri/runtime/guest-image \
  --output app/SiloUI/test-results/library-constraints-20260910
```

Use a new output directory for another run. Omit the two runtime arguments to
run only the library probes. The command requires macOS 14+, Python and Xcode
command-line tools; runtime testing also requires Apple Silicon virtualization.
It does not change system security settings or the supplied app bundle.

The recorded run passed all 11 library cases and the optional real-VM checks.
`results.json` and individual command logs are retained under that ignored output
directory. The unique VM home was stopped and removed. The associated initial
tamper experiment's crash report confirmed `CODESIGNING`, `Invalid Page`; raw
system crash reports are not copied into the repository. Tampering is reported
separately from a library-constraint rejection because page signature enforcement
can terminate the loader rather than return a `dlopen` error.

## Limits and release requirements

- This establishes a library-load boundary while the constrained executable
  remains authentic. It does not authenticate a wholly replaced or redistributed
  app: anyone can ad-hoc sign a replacement executable with the rule removed.
  Silo's signed updater supplies a separate trusted delivery check.
- This does not detect compromised code that we intentionally approve and ship.
- macOS 14 introduced these APIs, but this run does not prove enforcement on
  macOS 14. Run the same tests on the minimum supported OS before claiming release
  coverage. Do not silently relax the rule if an OS rejects it.
- Generate the approved hash from the final signed engine. Sign the helper with
  `--enforce-constraint-validity`; require the constraint, hardened runtime and
  exact hash in package verification. Any later re-signing must preserve or
  regenerate the constraint. Do not approve libraries by signing identifier alone.
- The experiments are a proof, not a completed change to release packaging.

## Primary sources

- [Apple: Protect your Mac app with environment constraints](https://developer.apple.com/videos/play/wwdc2023/10266/), especially library constraints and replacing unrestricted loading.
- [Apple: Defining launch environment and library constraints](https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints).
- [Apple: Applying launch environment and library constraints](https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints).
- The installed `codesign(1)` manual: `--library-constraint`, `--enforce-constraint-validity`, and ad-hoc signing without an identity.
- [MicroSandbox's existing entitlements](https://github.com/superradcompany/microsandbox/blob/main/msb-entitlements.plist). They establish its current setting, not that a broader exception is unavoidable.
