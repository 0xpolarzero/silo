import type { AccountMigrationOutcome, AccountMigrationPlan, ApplicationSource, ApplicationWorkspace } from "@/features/application/model/application-source"

/** `?account-migration=…`: the dev sandbox still uses the old account layout. */
export const accountMigrationFixtureModes = ["required", "failed", "running", "no-space", "fails"] as const
export type AccountMigrationFixtureMode = (typeof accountMigrationFixtureModes)[number]

export function accountMigrationFixtureModeFromSearch(search: string): AccountMigrationFixtureMode | undefined {
  const requested = new URLSearchParams(search).get("account-migration")
  return accountMigrationFixtureModes.find((mode) => mode === requested)
}

const GIB = 1024 ** 3

export function fixtureBackupDirectory(sandbox: string): string {
  return `/Users/ada/Library/Application Support/org.silo.preview/runtime/account-migration-backups/${sandbox}-3f2a1b4c`
}

const failure = {
  error: "The account migration inside the sandbox stopped: UID/GID 1001 belongs to another account.",
  diagnostic: "Exit code 1\nTraceback (most recent call last):\n  File \"<string>\", line 161, in <module>\n  File \"<string>\", line 97, in migrate\nRuntimeError: UID/GID 1001 belongs to another account.",
}

export function withAccountMigrationFixture(source: ApplicationSource, mode: AccountMigrationFixtureMode | undefined): ApplicationSource {
  if (!mode) return source
  return {
    ...source,
    workspaces: source.workspaces.map((workspace): ApplicationWorkspace => {
      if (workspace.machine.name !== "dev" || workspace.computer) return workspace
      const accountMigration: ApplicationWorkspace["accountMigration"] = mode === "failed"
        ? { status: "failed", ...failure, backupDirectory: fixtureBackupDirectory("dev") }
        : mode === "running"
          ? { status: "running", stage: "Backing up the disks", backupDirectory: fixtureBackupDirectory("dev") }
          : { status: "required" }
      return { ...workspace, state: "stopped", stateDetail: "Stopped", attention: undefined, accountMigration }
    }),
  }
}

export function fixtureAccountMigrationPlan(workspace: ApplicationWorkspace, mode: AccountMigrationFixtureMode | undefined): AccountMigrationPlan {
  const name = workspace.machine.name
  const resume = workspace.accountMigration?.status === "failed" && Boolean(workspace.accountMigration.backupDirectory)
  const running = workspace.state === "running"
  const backupBytes = resume ? 0 : Math.round(6.6 * GIB)
  const requiredBytes = backupBytes + 2 * GIB
  const availableBytes = mode === "no-space" ? Math.round(4.2 * GIB) : Math.round(31.8 * GIB)
  const backupDirectory = fixtureBackupDirectory(name)
  return {
    sandbox: name,
    running,
    resume,
    steps: [
      ...(running ? [`Stop ${name}. Its terminals, editors and desktop disconnect.`] : []),
      resume ? "Keep the earlier backup and continue from where the last attempt stopped." : "Back up the root and workspace disks to the backup folder.",
      `Start ${name} and install Python, sudo and the SFTP server if they are missing. This needs network access.`,
      "Copy the root and desktop home folders into /home/silo, give the silo account (UID/GID 1001) ownership of /workspace, and install passwordless sudo for it. The original home folders stay in place.",
      `Verify the account, stop ${name}, and switch Silo to the silo account. ${name} stays stopped.`,
    ],
    backupDirectory,
    backupBytes,
    availableBytes,
    requiredBytes,
    enoughSpace: availableBytes >= requiredBytes,
  }
}

export const fixtureMigrationStages = [
  "Checking the sandbox",
  "Backing up the disks",
  "Starting the sandbox",
  "Installing required packages",
  "Moving files to the silo account",
  "Stopping and saving the account setting",
]

/** How a fixture migration ends: `fails` stops in the guest step, keeping its backup. */
export function fixtureMigrationOutcome(sandbox: string, mode: AccountMigrationFixtureMode | undefined): AccountMigrationOutcome {
  return mode === "fails"
    ? { succeeded: false, backupDirectory: fixtureBackupDirectory(sandbox), ...failure }
    : { succeeded: true, backupDirectory: fixtureBackupDirectory(sandbox) }
}
