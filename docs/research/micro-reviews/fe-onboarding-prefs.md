# Onboarding and preferences micro-review

Scope: `app/SiloUI/src/features/onboarding/` and `app/SiloUI/src/features/preferences/`.

Read-only source review. Prior review reports were checked for duplicates. No builds, tests, native UI, or live data were exercised.

## FE-ONBOARDING-PREFS-1: Notification enablement overwrites newer permission readback

- **Priority:** P2
- **File:line:** `app/SiloUI/src/features/preferences/system-integrations-store.ts:137–154` (also the preflight failure branch at lines 138–143).
- **Trigger:** Start `setNotificationsEnabled(true)` and hold its `service.read()` response, which contains `authorized`. Revoke notification permission externally and let a subsequent `refresh()` complete with `denied`. Then release the earlier preflight response.
- **Evidence:** `refresh()` captures a sequence and checks it before publishing. The notification preflight does not capture or check a sequence after its await. Instead, it increments `refreshSequence` and unconditionally publishes the earlier result at lines 145–147, then saves `notificationsEnabled: true` at lines 153–154. Focus events invoke `refresh()` independently through `desktop/system-integrations.ts`. The `notificationsPending` guard prevents another notification mutation, but does not prevent this refresh. The same missing check lets an older rejected preflight set `initialized: false` after a newer successful refresh.
- **Consequence:** The store replaces confirmed denied permission with stale authorized permission, saves an enabled preference, and exposes `notificationsAuthorized: true` until another refresh. A stale preflight failure can instead disable integration controls after a successful read. This is a state and error-handling defect; it does not bypass OS permission enforcement.
- **Suggested fix:** Apply response-order protection to the notification preflight and its error path. When an independent refresh supersedes the preflight, use the newer notification authority or perform another read before saving; do not publish or save the obsolete result. Preserve explicit mutation ordering when an authorization request is necessary.
- **Test that would catch it:** Use a deferred first `service.read()` and an immediate second read. Start notification enablement, complete a refresh with `denied`, then resolve the first read with `authorized`. Assert that final notification authority remains denied and enablement does not save `true` from the obsolete result. Repeat with the first read rejecting after the successful refresh and assert that `initialized` remains true.
