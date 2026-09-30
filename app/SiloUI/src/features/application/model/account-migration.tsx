import { createElement } from "react"

import { bridgeErrorMessage, hasBridgeErrorCode } from "@/contracts/bridge-error"
import { ErrorDetails } from "@/components/error-details"
import type { NoticeSandbox } from "@/desktop/notices"
import { errorMessage, showOperationFailure, showOperationNotice, showOperationSuccess, type OperationAction } from "@/lib/operation-toast"
import type { AccountMigrationOutcome } from "./application-source"
import { isCancelledError } from "./operation-queue"

/**
 * One migration request. Progress shows in the operation queue, where the backup step can be
 * cancelled; this reports the result under a stable id: a notice on success, the exact error
 * with Details, backup location and Retry on failure, and a neutral notice when cancelled.
 */
export interface AccountMigrationRun {
  /** Stable per sandbox (and computer), so a retry replaces the earlier result. */
  id: string
  sandbox: string
  /** The computer that owns a remote sandbox and keeps its backup. */
  computerName?: string
  noticeSandbox?: NoticeSandbox
  migrate: () => Promise<AccountMigrationOutcome>
  /** Offered on success, e.g. Start. */
  successAction?: OperationAction
}

function backupLine(directory: string | undefined, computerName: string | undefined): string | undefined {
  if (!directory) return undefined
  return `The backup is kept${computerName ? ` on ${computerName}` : ""} in ${directory}.`
}

export async function runAccountMigration(run: AccountMigrationRun): Promise<boolean> {
  const { id, sandbox, computerName, noticeSandbox } = run
  const retry = () => { void runAccountMigration(run) }
  const failureTitle = `Could not migrate ${sandbox}`
  try {
    const outcome = await run.migrate()
    const backup = backupLine(outcome.backupDirectory, computerName)
    if (outcome.succeeded) {
      showOperationSuccess(id, `${sandbox} now uses the silo account`, {
        description: [`It is stopped. Start it when you’re ready, then check your agents and files.`, backup].filter(Boolean).join(" "),
        action: run.successAction,
        persist: true,
        sandbox,
        noticeSandbox,
      })
      return true
    }
    const message = outcome.error ?? "The migration stopped."
    showOperationFailure(id, failureTitle, {
      description: createElement("div", { className: "grid gap-1.5" },
        createElement(ErrorDetails, { message, diagnostic: outcome.diagnostic }),
        backup ? createElement("p", null, `${backup} Retry continues with it.`) : createElement("p", null, "No backup was kept. Retry backs up the disks again.")),
      retry,
      sandbox,
      noticeSandbox,
    })
    return false
  } catch (cause) {
    if (isCancelledError(cause)) {
      showOperationNotice(id, "Migration cancelled", { description: `${sandbox} was not changed. It is stopped.`, sandbox })
    } else if (hasBridgeErrorCode(cause, "already_queued")) {
      showOperationNotice(id, `${sandbox} is already waiting to migrate`, { sandbox })
    } else {
      showOperationFailure(id, failureTitle, { description: migrationErrorMessage(cause), retry, sandbox, noticeSandbox })
    }
    return false
  }
}

/** Native commands reject with a bridge error object, other failures with an Error. */
export function migrationErrorMessage(cause: unknown): string {
  return bridgeErrorMessage(cause) ?? errorMessage(cause)
}
