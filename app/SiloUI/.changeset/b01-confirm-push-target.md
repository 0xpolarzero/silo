---
"silo-ui": minor
---

Push now asks for confirmation naming the GitHub repository, branch and commit before anything is sent, and publishes exactly that commit to that branch. If the sandbox's origin, branch or commit changes after you confirm, the push stops with "The repository changed after you confirmed the push" instead of publishing something else. Retrying a failed push from its row confirms the repository's current state again. Repositories without a GitHub origin can no longer start a push. Pushing to a sandbox on another computer requires Silo on both computers to include this change.
