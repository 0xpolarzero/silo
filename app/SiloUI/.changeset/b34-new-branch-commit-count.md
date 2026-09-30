---
"silo-ui": patch
---

Pushing a new branch now counts only the commits GitHub does not already have, instead of the branch's entire history (for example "Push 2 commits" rather than "Push 3,412 commits"). Pushing a new branch also no longer resends history that is already on the repository's default branch.
