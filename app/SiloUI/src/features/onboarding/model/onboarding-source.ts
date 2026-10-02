import { z } from "zod"

import type { ApplicationGitHubRepositoryPolicy, ApplicationGitHubWorkspacePolicy, ApplicationWorkspaceGitIdentity } from "@/features/application/model/application-source"

import {
  githubWorkspacePolicySchema,
  siloBootstrapConfigurationSchema,
  siloBootstrapResultSchema,
  siloBootstrapStateSchema,
  siloPreflightCheckSchema,
  siloProgressEventSchema,
  siloProtocolErrorSchema,
  setupMachineConfigurationRequestSchema,
  setupQueueItemIdSchema,
} from "@/contracts/silo"
import type { SetupMachineConfigurationRequest } from "@/contracts/silo"
import { applicationPreferenceSelectionSchema, type ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"

// This is the frontend's narrow input seam, not a Silo wire object. Each field
// remains an unmodified current protocol or app-state shape so a future bridge
// only has to replace the provider.
export const onboardingSourceSchema = z.object({
  readyToFinish: z.boolean().optional(),
  /**
   * Why Finish is unavailable after sandboxes were set up (one failed, is starting, or
   * its status is unconfirmed), with the action that resolves it, if any.
   */
  finishBlocker: z.object({
    message: z.string(),
    workspace: z.string(),
    action: z.enum(["start", "refresh"]).nullable(),
  }).strict().nullable().optional(),
  /**
   * False while `machineConfigurations` is a fallback (saved list or defaults) because
   * this computer's sandboxes have not loaded; the draft is seeded again once they do.
   */
  machinesAuthoritative: z.boolean().optional(),
  /** Sandboxes that already exist on this computer. Dropping one from the draft deletes it. */
  existingMachines: setupMachineConfigurationRequestSchema.shape.machines.optional(),
  setupQueue: z.array(z.object({ id: setupQueueItemIdSchema, status: z.enum(["idle", "queued", "running", "succeeded", "failed"]), failure: z.string().optional() }).strict()).optional(),
  machineConfigurations: setupMachineConfigurationRequestSchema.shape.machines,
  bootstrapConfiguration: siloBootstrapConfigurationSchema,
  bootstrapState: siloBootstrapStateSchema,
  preflightChecks: z.array(siloPreflightCheckSchema),
  progressEvents: z.array(siloProgressEventSchema),
  activityEvents: z.array(siloProgressEventSchema).optional(),
  activityError: z.string().optional(),
  githubPolicies: z.array(githubWorkspacePolicySchema),
  currentHostGitIdentity: z.object({
    name: z.string(),
    email: z.string(),
  }).strict().nullable(),
  applicationPreferences: applicationPreferenceSelectionSchema,
  bootstrapResult: siloBootstrapResultSchema.nullable(),
  error: siloProtocolErrorSchema.nullable(),
}).strict().superRefine((source, context) => {
  const result = setupMachineConfigurationRequestSchema.safeParse({
    schemaVersion: 1,
    machines: source.machineConfigurations,
  })
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ ...issue, path: ["machineConfigurations", ...issue.path.slice(1)] })
    }
  }
})

export type OnboardingSource = z.infer<typeof onboardingSourceSchema>

export type GitHubConnectionState = "disconnected" | "connecting" | "connected"

export type WorkspaceRepositorySelection = ApplicationGitHubRepositoryPolicy

export type WorkspaceGitIdentity = ApplicationWorkspaceGitIdentity

export interface OnboardingCompletionRequest {
  machineConfiguration: SetupMachineConfigurationRequest
  applications: ApplicationPreferenceSelection
  github: {
    connectionState: GitHubConnectionState
    workspaces: ApplicationGitHubWorkspacePolicy[]
  }
}

/**
 * Existing sandboxes (machine ids) the user explicitly confirmed deleting in this
 * session. A submission never deletes an existing sandbox that is not listed here.
 */
export interface OnboardingSubmissionOptions {
  confirmedDeletions: readonly string[]
}

export interface OnboardingActions {
  submitStep?: (step: "workspaces" | "github", request: OnboardingCompletionRequest, options?: OnboardingSubmissionOptions) => void
  cancelGitHubConnection?: () => void
  reopenGitHubAuthorization?: () => void
  connectGitHub: () => void
  saveMachineConfiguration: (request: SetupMachineConfigurationRequest, options?: OnboardingSubmissionOptions) => void
  /** Retry the last submission, rebuilt from `request` (the current draft) when given. */
  retryWorkspaceSetup: (request?: OnboardingCompletionRequest, options?: OnboardingSubmissionOptions) => void
  finishSetup: (request: OnboardingCompletionRequest, options?: OnboardingSubmissionOptions) => void
  /** Resolves a `finishBlocker` whose action is "start". */
  startWorkspace?: (workspace: string) => void
  /** Resolves a `finishBlocker` whose action is "refresh". */
  refreshSetupState?: () => void
}

export function parseOnboardingSource(input: unknown): OnboardingSource {
  return onboardingSourceSchema.parse(input)
}
