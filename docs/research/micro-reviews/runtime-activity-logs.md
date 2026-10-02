# Runtime activity and logs micro-review

Scope: `app/SiloUI/src-tauri/src/runtime_activity.rs` and `app/SiloUI/src-tauri/src/runtime_logs.rs`.

Read-only source review. No builds, tests, or application launches were performed. Prior findings in the two main review reports and the available pass-three reports were excluded, including R-01 and R-27.

## runtime-activity-logs-1: Oversized-record boundary drops the following log record

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime_logs.rs:320–323`; bounded read at lines 145–155.
- **Trigger:** A retained console or execution-log line occupies exactly `RECORD_LIMIT + 1` bytes including its terminating newline, followed by an ordinary valid record. For example, `kernel.log` contains 1,048,576 ASCII `x` bytes, a newline, and a timestamped `after` line.
- **Evidence:** `read_record` permits 1,048,577 bytes and `read_until` consumes the newline at that exact boundary. `scan` sets `oversized = true` because the count exceeds 1,048,576, then unconditionally calls `skip_line`. The reader already points at the next record, so `skip_line` consumes that record through its newline. `offset` advances past both lines, but `visit` receives only the first record. The existing oversized-record test uses longer lines whose newline lies beyond the bounded read, so it does not cover this boundary.
- **Consequence:** The following valid record disappears from search, pagination, surrounding context, and exports using the log reader. Follow also carries the advanced consumed offset and never indexes the skipped record. If the following line contains the failure explanation, that explanation is unavailable despite remaining in the retained file.
- **Suggested fix:** In the oversized branch, check whether the bounded bytes already end in a newline. If they do, use `(count, true)` without calling `skip_line`; otherwise skip the remainder as today.
- **Test that would catch it:** Write the exact-boundary console line followed by two timestamped sentinel lines, query all pages, and assert that both sentinels remain present alongside the truncated oversized record. Repeat with an execution JSON record of exactly 1,048,577 bytes including its newline, expecting the oversized placeholder plus both valid subsequent records. Verify searching for the first sentinel and following an initial snapshot taken before these appends.
