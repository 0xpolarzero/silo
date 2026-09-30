---
"silo-ui": minor
---

Changes sent to another computer no longer wait behind every other remote change: changes to different sandboxes run at the same time, and changes to the same sandbox wait their turn in that computer's queue like local work. A queued change that has not started before its request expires, or whose computer disconnected, is dropped instead of running later, and Silo reports that nothing changed. After a brief connection loss Silo asks again for the same change and receives its result instead of running it twice. Both computers need this version of Silo.
