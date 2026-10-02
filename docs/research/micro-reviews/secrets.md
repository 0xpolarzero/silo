# Secrets micro-review

Scope: `app/SiloUI/src-tauri/src/secrets.rs` and `app/SiloUI/src-tauri/src/secrets_runtime.rs`.

Read-only source review. Checked the two existing review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for overlap. No builds, tests, live credentials, or VMs were used. Runtime callers were read to establish concurrency and consequences.

## SECRETS-1: A permitted save can make the secrets document unreadable

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/secrets.rs:193`, `:205`, `:457`.
- **Trigger:** Accumulate accepted secret records whose serialized metadata exceeds 2 MiB. Validation permits 100 domains per secret, each up to 253 bytes, and places no bound on total secret count or document size. For example, 90 records containing 100 accepted 253-byte domains already contain 2,277,000 domain bytes, before JSON overhead. Duplicate domains are also accepted, so this does not require 9,000 distinct hosts.
- **Evidence:** `save` serializes the entire document without a size check and persists it atomically. `load` parses only `file.take(2 * 1024 * 1024)`. The next read therefore sees truncated JSON and returns the settings-read error. `save_secret` commits the oversized document before `reconcile` attempts another `load`.
- **Consequence:** The save returns an error after replacing the previously readable document. Listing, editing, removing, and retrying secrets fail on every subsequent load, including after relaunch. Runtime material and application-state reads also fail because they load this document. Recovery requires editing or restoring the file outside the application.
- **Suggested fix:** Enforce a shared serialized-document limit before replacing the existing file, with a capacity error that leaves the old document intact. Apply the rule to every document writer, including revocation and activity updates, and account for recovery operations when choosing the limit.
- **Test that would catch it:** Build a valid document just below the reader limit, then add enough valid metadata to exceed it. Assert the attempted save fails before replacement and the previous document still loads and can remove a secret. This regression must exercise the real `save`/`load` seam.

## SECRETS-2: A save can resurrect assignments after sandbox deletion

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/secrets.rs:751`, `:766`, `:780`, `:361`.
- **Trigger:** A save validates workspace `dev`, then pauses in a credential-store read/write at lines 759–761. Concurrent sandbox deletion completes and calls `workspace_removed("dev")`. The save then resumes and persists its request, still assigning the secret to `dev`.
- **Evidence:** `save_secret` holds `OPERATION`, but `workspace_removed` does not acquire that lock. Their individual document writes use `DOCUMENT`; that lock does not span workspace validation, credential persistence, and assignment commit. The save unconditionally copies `request.workspaces` into the new record after deletion has removed the old assignments. The production deletion path calls `workspace_removed` after runtime removal and metadata persistence (`runtime.rs:5143–5149`). Workspace validation takes no per-VM gate and checks names, not a captured stable machine ID (`runtime.rs:11846–11868`). `runtime_material` selects assignments solely by workspace name at `secrets.rs:252`.
- **Consequence:** Deletion's assignment cleanup is undone. If a sandbox is subsequently created with the same name, it inherits secret access without an assignment to that new sandbox. An intervening failed reconcile does not remove the resurrected assignment.
- **Suggested fix:** Commit assignments against the validated stable machine identity under a synchronization boundary shared with deletion. Ensure deletion invalidates pending saves for that identity; a second name-only existence check does not protect against delete-and-recreate.
- **Test that would catch it:** Pause an actual save at an injected credential-store seam after workspace validation, delete the selected sandbox and complete its assignment cleanup, then resume the save. Assert it rejects the obsolete identity and persists no assignment for a replacement sandbox with the same name. Also cover deletion and recreation before the save resumes.
