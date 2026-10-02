# Remote core micro-review

Scope: `app/SiloUI/src-tauri/src/remote.rs`.

Read-only source review. No builds, tests, or live sessions were run. Findings were checked against the first review, pass 2, and the available pass 3 reports; previously reported defects are omitted.

## REMOTE-CORE-1: Concurrent key migrations undo a successful restriction

- **Severity:** P2.
- **File:line:** `app/SiloUI/src-tauri/src/remote.rs:767`, `:771`, `:783`; concurrent dispatch at `:1622` and `:1757`.
- **Trigger:** Two controllers with different older unrestricted Silo keys connect concurrently. Both migration calls read the same original `authorized_keys`. Controller A finishes its rewrite and rename; controller B then writes and renames its already-computed snapshot. Handshakes execute as reads outside the change registry, and no lock covers this read-modify-write sequence.
- **Evidence:** `restrict_authorized_keys` changes only the supplied key's line and preserves every other line from its input (`738–753`). `restrict_authorized_keys_file` reads once, computes that replacement, and unconditionally renames it over the current file (`767–783`). Thus B's replacement contains A's original unrestricted line, even though A already returned `Ok(true)`. This schedule also permits both calls to finish successfully. The shared temporary filename and unconditional unlink introduce additional collisions, but a unique filename alone cannot prevent the stale-snapshot overwrite.
- **Consequence:** A successful security migration is reversed by another successful handshake, restoring unrestricted SSH authority for the first controller's key. This is distinct from GB-02's failed or skipped rewrite: neither call needs to fail here.
- **Suggested fix:** Serialize the entire authorized-keys read, transformation, and replacement within the owner; use a unique temporary file. Coordinate other Silo writers to the same file and preserve concurrent external edits rather than overwriting a stale snapshot.
- **Test that would catch it:** Seed two unrestricted Silo key lines and an unrelated sentinel line. Use barriers to make both migrations reach the read stage before allowing A to commit and then B to proceed. Require both key lines to remain restricted, the sentinel to remain intact, and no temporary-file collision. The current source permits B to restore A's unrestricted line.

## REMOTE-CORE-2: Blocking request writes bypass the operation deadline

- **Severity:** P2.
- **File:line:** `app/SiloUI/src-tauri/src/remote.rs:933`, `:939`, `:943`; blocking write at `:446`.
- **Trigger:** An exchange sends a frame below the 4 MiB limit but larger than the child's stdin pipe capacity, while the SSH transport stops consuming input. The same execution seam can be exercised with a child that keeps stdin open without reading it.
- **Evidence:** `run_exchange` calls `write_frame` synchronously on the child's blocking stdin before entering its process/deadline monitoring loop (`932–939`). `write_frame` uses `write_all` (`446–449`), and neither write has cancellation or a write deadline. The only deadline check and child termination are later, at `943–949`, so they cannot run while the request write is blocked. The existing exchange test at `2942` sends only a small frame and does not cover backpressure.
- **Consequence:** A stalled transport can hold the caller and its child beyond the advertised request deadline; the timeout and reaping path never runs until the write returns. This is separate from R-25's insufficient checkpoint budget.
- **Suggested fix:** Include request transmission in the same deadline and process ownership policy. Use deadline-aware nonblocking writes or a supervised writer whose pipe is released when the owned child is terminated, and reap on every failure path.
- **Test that would catch it:** Through the existing `run_exchange(Command, request, deadline)` seam, launch a bounded fixture child that retains stdin without reading, send a 1 MiB JSON frame, and set a short deadline. Assert timeout returns within a fixed bound and the owned child is reaped. Keep an outer watchdog so the regression test cannot hang the suite.
