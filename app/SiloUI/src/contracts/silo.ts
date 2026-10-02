import { z } from "zod"

const preflightStatusSchema = z.enum(["pending", "pass", "failed", "needsAction", "unavailable", "timeout"])

export const siloPreflightCheckSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: preflightStatusSchema,
  detail: z.string(),
  remediation: z.string().nullable(),
}).strict()

const siloBootstrapWorkspaceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  cpu: z.number().int().min(1).max(255),
  cpuCeiling: z.number().int().min(1).max(255),
  memoryGiB: z.number().int().min(1).max(4_294_967_295),
  memoryCeilingGiB: z.number().int().min(1).max(4_294_967_295),
  workspaceStorageGiB: z.number().int().min(1).max(4_194_303),
  runtimeStorageGiB: z.number().int().min(1).max(4_194_303),
}).strict().refine((workspace) => workspace.workspaceStorageGiB + workspace.runtimeStorageGiB <= 4_194_303, { message: "The two disks together exceed 4,194,303 GiB. Reduce a disk size.", path: ["workspaceStorageGiB"] }).refine((workspace) => workspace.cpu <= workspace.cpuCeiling, {
  message: "cpu must not exceed cpuCeiling",
}).refine((workspace) => workspace.memoryGiB <= workspace.memoryCeilingGiB, {
  message: "memoryGiB must not exceed memoryCeilingGiB",
})

export const siloBootstrapConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  workspaces: z.array(siloBootstrapWorkspaceSchema).min(1).max(64),
}).strict().refine((configuration) => {
  const names = configuration.workspaces.map(({ name }) => name)
  return new Set(names).size === names.length
}, { message: "Sandbox names must be unique." })

const desktopConfigurationSchema = z.object({
  startWithSandbox: z.boolean(),
  // Reported for VMs whose desktop is built into the image (v4). Read-only: the desktop always starts.
  builtIn: z.boolean().optional(),
}).strict()

export const setupWorkspaceConfigurationSchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  cpus: z.number().int().min(1).max(255),
  maxCPUs: z.number().int().min(1).max(255),
  memoryGiB: z.number().int().min(1).max(4_294_967_295),
  maxMemoryGiB: z.number().int().min(1).max(4_294_967_295),
  workspaceStorageGiB: z.number().int().min(1).max(4_194_303),
  runtimeStorageGiB: z.number().int().min(1).max(4_194_303),
  desktop: desktopConfigurationSchema.optional(),
}).strict().refine((workspace) => workspace.workspaceStorageGiB + workspace.runtimeStorageGiB <= 4_194_303, { message: "The two disks together exceed 4,194,303 GiB. Reduce a disk size.", path: ["workspaceStorageGiB"] }).refine((workspace) => workspace.cpus <= workspace.maxCPUs, {
  message: "cpus must not exceed maxCPUs",
}).refine((workspace) => workspace.memoryGiB <= workspace.maxMemoryGiB, {
  message: "memoryGiB must not exceed maxMemoryGiB",
})

export const setupVirtualMachineConfigurationSchema = setupWorkspaceConfigurationSchema.extend({
  kind: z.literal("vm"),
}).strict()

export const setupSSHMachineConfigurationSchema = z.object({
  id: z.uuid(),
  kind: z.literal("ssh"),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  host: z.string().trim().min(1).max(253).regex(/^\S+$/),
  user: z.string().trim().min(1).max(64).regex(/^[a-zA-Z_][a-zA-Z0-9._-]*$/),
  port: z.number().int().min(1).max(65_535),
}).strict()

export const setupMachineConfigurationSchema = z.discriminatedUnion("kind", [
  setupVirtualMachineConfigurationSchema,
  setupSSHMachineConfigurationSchema,
])

export const setupMachineConfigurationRequestSchema = z.object({
  schemaVersion: z.literal(1),
  machines: z.array(setupMachineConfigurationSchema).max(64),
}).strict().refine((configuration) => {
  const names = configuration.machines.map(({ name }) => name.toLowerCase())
  return new Set(names).size === names.length
}, { message: "Sandbox names must be unique." }).refine((configuration) => {
  const ids = configuration.machines.map(({ id }) => id)
  return new Set(ids).size === ids.length
}, { message: "Sandbox IDs must be unique." })

const siloBootstrapPhaseSchema = z.enum([
  "welcome",
  "preflight",
  "toolchain",
  "hostIntegration",
  "workspaces",
  "github",
  "identity",
  "complete",
])

export const siloBootstrapStateSchema = z.object({
  phase: siloBootstrapPhaseSchema,
  startedAt: z.number().optional(),
  updatedAt: z.number(),
  lastError: z.string().optional(),
  completedPhases: z.array(siloBootstrapPhaseSchema),
  workspaceConfigurations: z.array(setupWorkspaceConfigurationSchema).optional(),
  phaseDurations: z.record(z.string(), z.number().nonnegative()),
}).strict()

export const siloProgressEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("progress"),
  requestId: z.string().trim().min(1),
  phase: z.string().trim().min(1),
  step: z.string().optional(),
  workspace: z.string().optional(),
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  fraction: z.number().min(0).max(1).optional(),
  message: z.string(),
  safeForDisplay: z.boolean(),
  timestamp: z.number().int().nonnegative().optional(),
  level: z.enum(["info", "warning", "error"]).optional(),
  elapsedSeconds: z.number().nonnegative().optional(),
  downloadedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  failureCode: z.enum(["auth", "access", "disk", "permission", "network", "timeout", "integrity", "resources", "configuration", "unavailable", "runtime"]).optional(),
  exitCode: z.number().int().optional(),
  /** `setup-failed` only: the runtime's own explanation for a Details disclosure; never part of `message`. */
  diagnostic: z.string().optional(),
  /** Some setup changes completed before this failure. */
  partial: z.boolean().optional(),
}).strict()

export const siloBootstrapResultSchema = z.object({
  resumed: z.boolean(),
  phase: z.string(),
  requiresApproval: z.boolean(),
  vmsStarted: z.boolean(),
  message: z.string(),
}).strict()

export const siloProtocolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  recovery: z.string().nullable(),
  workspace: z.string().nullable(),
  retryable: z.boolean(),
}).strict()

const githubRepositoryPolicySchema = z.object({
  workspace: z.string().min(1),
  repositoryID: z.number().int(),
  fullName: z.string().min(1),
  ownerID: z.number().int(),
  ownerLogin: z.string().min(1),
  ownerType: z.string().nullable(),
  mode: z.enum(["read-only", "read-write"]),
}).strict()

export const githubWorkspacePolicySchema = z.object({
  workspace: z.string().min(1),
  repositories: z.array(githubRepositoryPolicySchema),
}).strict().refine((policy) => (
  policy.repositories.every((repository) => repository.workspace === policy.workspace)
), { message: "Repository sandboxes must match the sandbox access policy." })

export const setupQueueItemIdSchema = z.enum([
  "workspaceRun",
  "workspaceVerify",
  "githubRun",
  "githubVerify",
  "identityRun",
  "identityVerify",
  "completion",
])

export type SiloPreflightCheck = z.infer<typeof siloPreflightCheckSchema>
export type SiloBootstrapConfiguration = z.infer<typeof siloBootstrapConfigurationSchema>
export type SetupMachineConfiguration = z.infer<typeof setupMachineConfigurationSchema>
export type SetupMachineConfigurationRequest = z.infer<typeof setupMachineConfigurationRequestSchema>
export type SetupSSHMachineConfiguration = z.infer<typeof setupSSHMachineConfigurationSchema>
export type SetupVirtualMachineConfiguration = z.infer<typeof setupVirtualMachineConfigurationSchema>
export type SiloProgressEvent = z.infer<typeof siloProgressEventSchema>
export type SiloBootstrapResult = z.infer<typeof siloBootstrapResultSchema>
export type SiloProtocolError = z.infer<typeof siloProtocolErrorSchema>
export type SetupQueueItemID = z.infer<typeof setupQueueItemIdSchema>
