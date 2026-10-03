import type { ApplicationActivity, ApplicationActivityCategory } from "@/features/application/model/application-source"

export const activityFixtureModes = [
  "catalog",
  "computer-live",
  "git-live",
  "backup-live",
  "secrets-live",
  "github-live",
  "system-live",
] as const

export type ActivityFixtureMode = (typeof activityFixtureModes)[number]

type CompletedActivity = Omit<ApplicationActivity, "occurredAt" | "time" | "status">

const fixtureNow = Date.parse("2026-09-04T16:00:00Z")

function completed(index: number, activity: CompletedActivity): ApplicationActivity {
  return {
    ...activity,
    occurredAt: new Date(fixtureNow - index * 60_000).toISOString(),
    time: index === 0 ? "Now" : `${index}m ago`,
    status: "completed",
  }
}

function live(
  id: string,
  category: ApplicationActivityCategory,
  title: string,
  detail: string,
  computer?: string,
  progress?: number,
  progressLabel?: string,
  tone: ApplicationActivity["tone"] = "neutral",
  status: ApplicationActivity["status"] = "running",
): ApplicationActivity {
  return {
    id,
    category,
    title,
    detail,
    computer,
    progress,
    progressLabel,
    tone,
    status,
    occurredAt: "2026-09-04T16:00:00.000Z",
    time: status === "running" ? "Now" : "Just now",
  }
}

export const defaultApplicationActivities: ApplicationActivity[] = [
  completed(1, { id: "dev-start", category: "computer", title: "Start verified", detail: "A fresh observation confirmed that the computer is running.", computer: "dev", tone: "success" }),
  completed(2, { id: "playgrounds-stop", category: "computer", title: "Stop verified", detail: "A fresh observation confirmed that the computer is stopped.", computer: "playgrounds", tone: "success" }),
  completed(3, { id: "dev-push", category: "git", title: "Push completed", detail: "Pushed 3 commits from acme/silo on main.", computer: "dev", tone: "success" }),
  completed(4, { id: "personal-backup", category: "backup", title: "Export completed", detail: "Export file verification passed.", tone: "success" }),
]

export const activityCatalog: ApplicationActivity[] = [
  completed(1, { id: "catalog-state-changed", category: "computer", title: "State changed", detail: "Silo returned updated state for 3 computers.", tone: "neutral" }),
  completed(2, { id: "catalog-start-verified", category: "computer", title: "Start verified", detail: "A fresh observation confirmed that the computer is running.", computer: "dev", tone: "success" }),
  completed(3, { id: "catalog-stop-verified", category: "computer", title: "Stop verified", detail: "A fresh observation confirmed that the computer is stopped.", computer: "playgrounds", tone: "success" }),
  completed(4, { id: "catalog-restart-verified", category: "computer", title: "Restart verified", detail: "The computer returned to a fresh running state.", computer: "dev", tone: "success" }),
  completed(5, { id: "catalog-start-failed", category: "computer", title: "Start failed", detail: "The computer could not mount its workspace storage.", computer: "dev", tone: "danger" }),
  completed(6, { id: "catalog-stop-failed", category: "computer", title: "Stop failed", detail: "The computer did not stop before the operation timed out.", computer: "playgrounds", tone: "danger" }),
  completed(7, { id: "catalog-restart-failed", category: "computer", title: "Restart failed", detail: "The computer did not return to a running state.", computer: "dev", tone: "danger" }),
  completed(8, { id: "catalog-restart-unknown", category: "computer", title: "Restart outcome unknown", detail: "The command completed, but a fresh observation was unavailable.", computer: "dev", tone: "warning" }),
  completed(9, { id: "catalog-lifecycle-loss", category: "computer", title: "Computer stopped unexpectedly", detail: "A fresh observation shows that the computer is no longer running.", computer: "personal", tone: "warning" }),
  completed(10, { id: "catalog-quarantined", category: "computer", title: "Computer quarantined", detail: "Credential safety could not be verified. Actions remain blocked.", computer: "playgrounds", tone: "danger" }),
  completed(11, { id: "catalog-unavailable", category: "computer", title: "Computer unavailable", detail: "The latest state observation failed. The last known status is shown.", computer: "dev", tone: "warning" }),
  completed(12, { id: "catalog-recovered", category: "computer", title: "Computer recovered", detail: "Fresh state is available again.", computer: "dev", tone: "success" }),
  completed(13, { id: "catalog-added", category: "computer", title: "Computer added", detail: "The new computer passed configuration and verification.", computer: "personal", tone: "success" }),
  completed(14, { id: "catalog-config-updated", category: "computer", title: "Computer configuration updated", detail: "CPU, memory, and storage settings were applied.", computer: "dev", tone: "success" }),
  completed(15, { id: "catalog-removed", category: "computer", title: "Computer removed", detail: "The computer was deleted.", computer: "playgrounds", tone: "neutral" }),
  completed(16, { id: "catalog-network-ready", category: "computer", title: "Networking ready", detail: "Candidate networking passed readiness checks.", computer: "dev", tone: "success" }),
  completed(17, { id: "catalog-network-failed", category: "computer", title: "Networking failed", detail: "Candidate forwarding did not become ready.", computer: "playgrounds", tone: "danger" }),
  completed(18, { id: "catalog-verification-passed", category: "computer", title: "Verification passed", detail: "The computer passed deep verification.", computer: "dev", tone: "success" }),
  completed(19, { id: "catalog-verification-failed", category: "computer", title: "Verification failed", detail: "The computer failed its storage check.", computer: "playgrounds", tone: "danger" }),
  completed(20, { id: "catalog-host-approval", category: "computer", title: "Host approval required", detail: "Approve the Silo host helper before setup can continue.", tone: "warning" }),
  completed(21, { id: "catalog-setup-complete", category: "computer", title: "Setup completed", detail: "Configuration was committed after deep verification.", tone: "success" }),
  completed(22, { id: "catalog-setup-failed", category: "computer", title: "Setup failed", detail: "The staged configuration was discarded safely.", tone: "danger" }),

  completed(23, { id: "catalog-push-complete", category: "git", title: "Push completed", detail: "Pushed 2 commits from acme/silo on main.", computer: "dev", tone: "success" }),
  completed(24, { id: "catalog-push-failed", category: "git", title: "Push failed", detail: "The remote branch changed after review.", computer: "dev", tone: "danger" }),
  completed(25, { id: "catalog-push-blocked", category: "git", title: "Push blocked", detail: "Repository policy does not allow this push.", computer: "dev", tone: "warning" }),
  completed(26, { id: "catalog-push-unknown", category: "git", title: "Push outcome unknown", detail: "The push returned without authoritative reconciliation.", computer: "dev", tone: "warning" }),
  completed(27, { id: "catalog-clone-complete", category: "git", title: "Clone completed", detail: "Cloned acme/design-system into the computer.", computer: "dev", tone: "success" }),
  completed(28, { id: "catalog-clone-failed", category: "git", title: "Clone failed", detail: "Repository access could not be verified.", computer: "dev", tone: "danger" }),
  completed(29, { id: "catalog-pull-complete", category: "git", title: "Pull completed", detail: "Updated acme/platform-tools on main.", computer: "playgrounds", tone: "success" }),
  completed(30, { id: "catalog-pull-failed", category: "git", title: "Pull failed", detail: "Local changes prevented a safe update.", computer: "dev", tone: "danger" }),

  completed(31, { id: "catalog-backup-complete", category: "backup", title: "Export completed", detail: "The export file and checksum were written successfully.", tone: "success" }),
  completed(32, { id: "catalog-backup-restart", category: "backup", title: "Export completed · restart required", detail: "The export file is valid. Start dev to resume work.", tone: "warning" }),
  completed(33, { id: "catalog-backup-failed", category: "backup", title: "Export failed", detail: "The destination became unavailable while writing the export file.", tone: "danger" }),
  completed(34, { id: "catalog-restore-complete", category: "backup", title: "Import completed", detail: "Every computer was observed fresh and stopped.", tone: "success" }),
  completed(35, { id: "catalog-restore-unknown", category: "backup", title: "Import outcome unknown", detail: "The export file was applied, but imported state could not be verified.", tone: "warning" }),
  completed(36, { id: "catalog-restore-failed", category: "backup", title: "Import failed", detail: "The export file checksum did not match.", tone: "danger" }),

  completed(37, { id: "catalog-secret-added", category: "secrets", title: "Secret added", detail: "PACKAGE_TOKEN was assigned to 2 computers.", tone: "success" }),
  completed(38, { id: "catalog-secret-edited", category: "secrets", title: "Secret updated", detail: "DATABASE_URL metadata and value were replaced.", computer: "dev", tone: "success" }),
  completed(39, { id: "catalog-secret-removed", category: "secrets", title: "Secret removed", detail: "The binding was verified absent before its value was deleted.", computer: "playgrounds", tone: "success" }),
  completed(40, { id: "catalog-secret-failed", category: "secrets", title: "Secret change failed", detail: "The reviewed change could not be applied.", computer: "dev", tone: "danger" }),
  completed(41, { id: "catalog-secret-restart", category: "secrets", title: "Secret restart required", detail: "Restart dev to apply the pending secret generation.", computer: "dev", tone: "warning" }),
  completed(42, { id: "catalog-secret-next-start", category: "secrets", title: "Secret applies on next start", detail: "The stopped computer will receive the change when it starts.", computer: "personal", tone: "neutral" }),
  completed(43, { id: "catalog-secret-removal-pending", category: "secrets", title: "Secret removal pending restart", detail: "Restart playgrounds to verify that the old binding is absent.", computer: "playgrounds", tone: "warning" }),
  completed(44, { id: "catalog-secret-restart-complete", category: "secrets", title: "Secret restart completed", detail: "Every affected computer now reports the active generation.", tone: "success" }),
  completed(45, { id: "catalog-secret-verification-failed", category: "secrets", title: "Secret verification failed", detail: "The computer restarted, but the secret state remained pending.", computer: "dev", tone: "danger" }),

  completed(46, { id: "catalog-github-connected", category: "github", title: "GitHub connected", detail: "Connected account taylor.", tone: "success" }),
  completed(47, { id: "catalog-github-disconnected", category: "github", title: "GitHub disconnected", detail: "Computer grants were removed before the account was disconnected.", tone: "neutral" }),
  completed(48, { id: "catalog-auth-denied", category: "github", title: "Authorization denied", detail: "GitHub denied the device authorization request.", tone: "danger" }),
  completed(49, { id: "catalog-auth-expired", category: "github", title: "Authorization expired", detail: "Start a new authorization session to continue.", tone: "warning" }),
  completed(50, { id: "catalog-auth-cancelled", category: "github", title: "Authorization cancelled", detail: "Existing access stayed unchanged.", tone: "neutral" }),
  completed(51, { id: "catalog-auth-failed", category: "github", title: "Authorization failed", detail: "GitHub could not be reached.", tone: "danger" }),
  completed(52, { id: "catalog-access-applied", category: "github", title: "GitHub access applied", detail: "The verified repository scope is active.", computer: "dev", tone: "success" }),
  completed(53, { id: "catalog-access-delayed", category: "github", title: "GitHub access delayed", detail: "The policy is saved locally and Silo will keep trying.", computer: "dev", tone: "warning" }),
  completed(54, { id: "catalog-access-failed", category: "github", title: "GitHub access failed", detail: "The saved policy could not be applied.", computer: "dev", tone: "danger" }),
  completed(55, { id: "catalog-sync-cancelled", category: "github", title: "GitHub sync cancelled", detail: "The saved choices remain available for retry.", computer: "dev", tone: "neutral" }),
  completed(56, { id: "catalog-grant-stored", category: "github", title: "Access saved", detail: "Verified repository access was saved.", computer: "dev", tone: "success" }),
  completed(57, { id: "catalog-push-enabled", category: "github", title: "Push access enabled", detail: "Push from computer was enabled for acme/docs.", computer: "dev", tone: "success" }),
  completed(58, { id: "catalog-repository-removed", category: "github", title: "Repository access removed", detail: "acme/docs was removed from this computer.", computer: "dev", tone: "neutral" }),
  completed(59, { id: "catalog-disconnect-incomplete", category: "github", title: "GitHub disconnect incomplete", detail: "GitHub was disabled, but its Mac credential could not be fully removed.", tone: "danger" }),
  completed(60, { id: "catalog-reauthenticated", category: "github", title: "GitHub reauthenticated", detail: "The Mac credential was replaced and verified.", tone: "success" }),
  completed(61, { id: "catalog-identity-updated", category: "github", title: "Git identity updated", detail: "The configured name and email were applied.", tone: "success" }),

  completed(62, { id: "catalog-runtime-installed", category: "system", title: "Runtime installed", detail: "The bundled Silo toolchain was activated.", tone: "success" }),
  completed(63, { id: "catalog-configuration-installed", category: "system", title: "Default configuration installed", detail: "The bundled default configuration is active.", tone: "success" }),
  completed(64, { id: "catalog-runtime-verified", category: "system", title: "Runtime verification passed", detail: "The activated command identity and handshake were verified.", tone: "success" }),
  completed(65, { id: "catalog-runtime-verification-failed", category: "system", title: "Runtime verification failed", detail: "The activated command did not pass its handshake.", tone: "danger" }),
  completed(66, { id: "catalog-repair-complete", category: "system", title: "Runtime repair completed", detail: "The runtime and default configuration are ready.", tone: "success" }),
  completed(67, { id: "catalog-repair-failed", category: "system", title: "Runtime repair failed", detail: "The bundled runtime could not be verified after installation.", tone: "danger" }),
  completed(68, { id: "catalog-health-passed", category: "system", title: "Health checks passed", detail: "Every required preflight check passed.", tone: "success" }),
  completed(69, { id: "catalog-health-failed", category: "system", title: "Health check failed", detail: "Workspace disk needs repair.", tone: "danger" }),
  completed(70, { id: "catalog-health-unavailable", category: "system", title: "Health check unavailable", detail: "The runtime could not answer this check.", tone: "warning" }),
  completed(71, { id: "catalog-port-conflict", category: "system", title: "Published port conflict", detail: "Port 5173 is already in use and was skipped.", computer: "dev", tone: "warning" }),
  completed(72, { id: "catalog-port-cleared", category: "system", title: "Published port conflict cleared", detail: "Port 5173 is available again.", computer: "dev", tone: "success" }),
  completed(73, { id: "catalog-clean-complete", category: "system", title: "Clean completed", detail: "Managed temporary state was removed.", computer: "dev", tone: "success" }),
  completed(74, { id: "catalog-clean-failed", category: "system", title: "Clean failed", detail: "Managed state could not be removed safely.", computer: "dev", tone: "danger" }),
  completed(75, { id: "catalog-resize-complete", category: "system", title: "Computer resized", detail: "The new memory and CPU limits are effective.", computer: "dev", tone: "success" }),
  completed(76, { id: "catalog-resize-failed", category: "system", title: "Resize failed", detail: "The requested resource limits were not applied.", computer: "dev", tone: "danger" }),
  completed(77, { id: "catalog-upgrade-complete", category: "system", title: "Upgrade completed", detail: "Managed computers are using the new runtime version.", tone: "success" }),
  completed(78, { id: "catalog-upgrade-failed", category: "system", title: "Upgrade failed", detail: "The previous runtime remains active.", tone: "danger" }),
  completed(79, { id: "catalog-update-complete", category: "system", title: "Silo update completed", detail: "The requested update completed successfully.", tone: "success" }),
  completed(80, { id: "catalog-update-failed", category: "system", title: "Silo update failed", detail: "The current installation remains active.", tone: "danger" }),
  completed(81, { id: "catalog-deep-check-complete", category: "system", title: "Deep check completed", detail: "Every destructive verification check passed.", tone: "success" }),
  completed(82, { id: "catalog-deep-check-failed", category: "system", title: "Deep check failed", detail: "One or more required checks need repair.", tone: "danger" }),
]

const liveSequences: Record<Exclude<ActivityFixtureMode, "catalog">, readonly ApplicationActivity[]> = {
  "computer-live": [
    live("live-computer", "computer", "Configuring computer", "Creating the computer and reconciling its storage.", "personal", 0.2, "Computer configuration 20% complete"),
    live("live-computer", "computer", "Preparing networking", "Starting candidate forwarding and readiness checks.", "personal", 0.5, "Computer configuration 50% complete"),
    live("live-computer", "computer", "Verifying computer", "Running the complete deep verification.", "personal", 0.8, "Computer configuration 80% complete"),
    live("live-computer", "computer", "Computer added", "Configuration was committed after verification.", "personal", 1, "Computer configuration complete", "success", "completed"),
  ],
  "git-live": [
    live("live-git", "git", "Pushing commits", "Pushing 2 commits from acme/silo on main.", "dev"),
    live("live-git", "git", "Push completed", "Pushed 2 commits from acme/silo on main.", "dev", 1, "Push complete", "success", "completed"),
  ],
  "backup-live": [
    live("live-backup", "backup", "Preparing export", "Saving a checkpoint after flushing computer files.", undefined, 0.1, "Export 10% complete"),
    live("live-backup", "backup", "Writing export file", "Scanning, compressing, and writing the destination.", undefined, 0.45, "Export 45% complete"),
    live("live-backup", "backup", "Checksumming export file", "Verifying the completed export file.", undefined, 0.75, "Export 75% complete"),
    live("live-backup", "backup", "Finalizing export", "Saving the durable result.", undefined, 0.92, "Export 92% complete"),
    live("live-backup", "backup", "Export completed", "The export file and checksum were written successfully.", undefined, 1, "Export complete", "success", "completed"),
  ],
  "secrets-live": [
    live("live-secrets", "secrets", "Applying secret change", "Updating DATABASE_URL for dev.", "dev"),
    live("live-secrets", "secrets", "Secret restart required", "Restart dev to apply the pending generation.", "dev", undefined, undefined, "warning", "completed"),
    live("live-secrets", "secrets", "Restarting for secrets", "Restarting dev and verifying its secret state.", "dev"),
    live("live-secrets", "secrets", "Secret change active", "The updated generation is active in dev.", "dev", 1, "Secret change complete", "success", "completed"),
  ],
  "github-live": [
    live("live-github", "github", "GitHub access saved", "Waiting to apply the reviewed repository policy.", "dev", 0.15, "GitHub access 15% complete"),
    live("live-github", "github", "Applying GitHub access", "Binding and verifying the scoped computer grant.", "dev", 0.55, "GitHub access 55% complete"),
    live("live-github", "github", "GitHub access delayed", "The policy is saved locally and Silo will keep trying.", "dev", 0.7, "GitHub access delayed", "warning"),
    live("live-github", "github", "GitHub access applied", "The verified repository scope is active.", "dev", 1, "GitHub access complete", "success", "completed"),
  ],
  "system-live": [
    live("live-system", "system", "Installing runtime", "Activating the bundled Silo toolchain.", undefined, 0.2, "Runtime repair 20% complete"),
    live("live-system", "system", "Installing default configuration", "Applying the bundled default configuration.", undefined, 0.5, "Runtime repair 50% complete"),
    live("live-system", "system", "Verifying runtime", "Checking the activated command identity and handshake.", undefined, 0.8, "Runtime repair 80% complete"),
    live("live-system", "system", "Runtime repair completed", "The runtime and default configuration are ready.", undefined, 1, "Runtime repair complete", "success", "completed"),
  ],
}

export function activityFixtureModeFromSearch(search: string): ActivityFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("activity")
  return activityFixtureModes.find((mode) => mode === requested)
}

export function activityFixtureStepCount(mode?: ActivityFixtureMode): number {
  return mode && mode !== "catalog" ? liveSequences[mode].length : 1
}

export function applicationActivitiesForFixture(
  mode: ActivityFixtureMode | undefined,
  step: number,
  fallback: readonly ApplicationActivity[],
): ApplicationActivity[] {
  if (!mode) return fallback.map((activity) => ({ ...activity }))
  if (mode === "catalog") return activityCatalog.map((activity) => ({ ...activity }))
  const sequence = liveSequences[mode]
  const current = sequence[Math.min(Math.max(step, 0), sequence.length - 1)]
  return [
    { ...current },
    ...activityCatalog
      .filter((activity) => (
        activity.category === current.category
        && (activity.title !== current.title || activity.detail !== current.detail)
      ))
      .map((activity) => ({ ...activity })),
  ]
}
