---
"silo-ui": patch
---

When Silo closes during an export or import, the next launch no longer repeats the whole operation or starts sandboxes that were running when it began, and no longer holds back sandbox startup while an export is checked. An export whose file was already saved is verified and reported as complete; otherwise the incomplete file is removed and the export is reported as interrupted. An import whose sandbox was already saved is reported as imported instead of failing with "already exists"; otherwise its partial sandbox record is removed and the import is reported as interrupted.
