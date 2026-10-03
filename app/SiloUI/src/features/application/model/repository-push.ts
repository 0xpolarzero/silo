import type { ApplicationRepository, RepositoryPushTarget } from "./application-source"

export function commitLabel(count: number) {
  return `${count} ${count === 1 ? "commit" : "commits"}`
}

/**
 * What a push of this repository would publish: its GitHub repository, current branch and
 * head commit. The user confirms exactly this and the host refuses to push anything else.
 * `null` when the computer did not report a GitHub origin or head commit.
 */
export function pushTarget(repository: Pick<ApplicationRepository, "branch" | "repository" | "head">): RepositoryPushTarget | null {
  if (!repository.repository || !repository.head || !repository.branch) return null
  return { repository: repository.repository, branch: repository.branch, commit: repository.head }
}

export function shortCommit(commit: string) {
  return commit.slice(0, 7)
}
