---
"silo-ui": patch
---

Connected computers now refresh independently: one slow or offline computer no longer freezes the status of the others or delays network checks, and a computer that stops answering shows its last known state as refreshing. Removed computers no longer reappear, saved remote edits no longer briefly revert, a newly connected computer is listed as soon as connecting finishes, and repeated actions on a remote sandbox are no longer ignored while its status refreshes. A failure to read the list of computers is now reported as such instead of as a remote management error.
