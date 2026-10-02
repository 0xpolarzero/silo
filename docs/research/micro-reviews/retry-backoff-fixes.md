# Retry backoff fixes

## Remote ChatGPT download status

- Trigger: a remote computer disconnects while its ChatGPT status store has a subscriber.
- Evidence: `computer-use-bridge.ts` selected only busy or idle polling intervals after read failures. The fake-timer regression in `computer-use-polling.test.tsx` observed a second read before the first backoff deadline.
- Consequence: an unavailable remote computer receives repeated connection attempts at the normal progress interval.
- Fix: double the delay after failed reads, cap it at 30 seconds, and reset it after a successful status read.
- Verification: the regression checks every deadline, repeated capped delays, recovery, and unsubscribe cleanup. Existing visibility and explicit-retry tests remain in the focused suite.

## Sandbox computer-use state

- Trigger: the computer-use panel remains active while sandbox state reads fail.
- Evidence: `ComputerUseSection` used an unconditional five-second interval. Its fake-timer regression observed another read before the first ten-second backoff deadline.
- Consequence: guest state reads or remote connection attempts continue at the normal progress interval throughout an outage.
- Fix: schedule the next read after completion, double the delay on failure up to 30 seconds, and reset the delay on success. Effect cleanup prevents in-flight reads from restarting an inactive schedule.
- Verification: the regression checks growing and capped delays, recovery, and inactivity; existing tests cover hidden documents and explicit mutations.

## Remote changes after a failed Quit

- Trigger: a remote mutation loses its response, Quit starts and fails, and admission reopens before the retry.
- Evidence: `send_change` checked only current admission after its delay. The exact-source disposable regression sent twice after a synthetic failed Quit, rejecting the required single-send behavior.
- Consequence: an action requested before shutdown can resume after the user began quitting, even though local retry sequences already stop across shutdown generations.
- Fix: capture the shutdown generation and reject later attempts with the cancellation error code when it changes. Check admission before each send.
- Verification: the native regression checks one send, typed cancellation, and reopened admission; existing tests check stable operation identities, retry caps, and terminal failures.

The standalone Rust verification extracts the production retry helper, failure classification, bridge error types, shutdown generation/admission functions, and both remote retry tests. It supplies only a local test isolation mutex and a maintenance-budget constant. Both tests pass against shared Cargo dependency artifacts. This verifies the retry seam without establishing whole-application compilation or live remote behavior.

## Desktop viewer health checks

- Trigger: the desktop viewer stays open while its computer is unreachable.
- Evidence: `NativeLinuxDesktopViewer` used an unconditional five-second interval. The fake-timer regression observed another failed health read before the first ten-second backoff deadline.
- Consequence: repeated guest state reads or connection attempts continue at the normal health-check interval during an outage.
- Fix: schedule reads after completion, double failure delays up to 30 seconds, and reset the delay after recovery. Visibility changes and effect cleanup cancel the pending schedule.
- Verification: the regression checks growing and capped delays, successful recovery, and closure; the existing recovery test verifies that a retired transport reattaches when the guest state remains unchanged.

## Guest accessibility bus failures

- Trigger: the accessibility worker cannot enumerate the desktop because its bus is unavailable.
- Evidence: every sweep exception set `changed` to true, resetting the polling delay. The deterministic worker regression observed six consecutive two-second delays.
- Consequence: a bus outage keeps accessibility requests and error logging at the fastest polling interval.
- Fix: treat a failed sweep as no observed content change so the existing idle backoff grows to its ten-second cap.
- Verification: the actual worker runs with a synthetic bus and clock. The regression checks growing delays, repeated capped delays, and restored two-second polling when a new application appears. Existing fairness and hung-application controls remain covered.

## Background VM health checks

- Trigger: runtime inspection keeps failing after the health watcher observed a running VM.
- Evidence: `HealthState::poll_interval` ignored the existing failure count. The regression against the extracted production health state returned ten seconds instead of the first twenty-second backoff.
- Consequence: background runtime inspections continue every ten seconds through an outage, including while application windows are hidden.
- Fix: double the active interval after each failed read, cap it at the existing five-minute idle fallback, and reset on a successful reading. Discarded reads leave the failure count unchanged.
- Verification: all eleven production health-state tests pass in a standalone Rust harness, including delay growth, repeated caps, recovery, and preservation of the idle fallback. Only Tauri installation is omitted and notice data types are supplied locally; no app or VM is launched.

## Update installation-gate reads

- Trigger: a ready update retains its snapshot while repeated updater reads fail.
- Evidence: `UpdatesProvider` used a three-second interval regardless of read errors. The fake-timer regression observed another call before the first six-second retry deadline.
- Consequence: updater checks continue at the fastest interval throughout an outage.
- Fix: schedule each poll after its read, double failed-read delays up to 30 seconds, and reset on a successful read or event. Focus still requests a read immediately.
- Verification: the regression checks growing and capped delays, recovery, and provider disposal; existing update tests cover subscription repair, installation ordering, and equal-snapshot rendering.

## Workspace file-tree refreshes

- Trigger: one visible folder keeps failing while other expanded folders remain readable.
- Evidence: the root's ten-second interval refreshed every visible path without considering its preceding error. The fixture regression observed a second failed folder read before the first twenty-second backoff deadline.
- Consequence: inaccessible folders keep invoking guest directory reads at the normal interval.
- Fix: retain a capped retry deadline per failing visible path. Healthy paths retain the ten-second interval, success clears that path's delay, and focus/visibility returns bypass the wait. Cleanup prevents completed reads from retaining an inactive schedule.
- Verification: the regression checks independent healthy-folder reads, growing and repeated sixty-second caps, recovery, and closure. Existing tests preserve immediate focus recovery and one root polling schedule.
