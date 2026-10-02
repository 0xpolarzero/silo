# Retry backoff fixes

## Remote ChatGPT download status

- Trigger: a remote computer disconnects while its ChatGPT status store has a subscriber.
- Evidence: `computer-use-bridge.ts` selected only busy or idle polling intervals after read failures. The fake-timer regression in `computer-use-polling.test.tsx` observed a second read before the first backoff deadline.
- Consequence: an unavailable remote computer receives repeated connection attempts at the normal progress interval.
- Fix: double the delay after failed reads, cap it at 30 seconds, and reset it after a successful status read.
- Verification: the regression checks every deadline, repeated capped delays, recovery, and unsubscribe cleanup. Existing visibility and explicit-retry tests remain in the focused suite.
