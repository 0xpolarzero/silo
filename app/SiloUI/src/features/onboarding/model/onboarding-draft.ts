import { z } from "zod"

import {
  setupMachineConfigurationRequestSchema,
  setupSSHMachineConfigurationSchema,
  setupVirtualMachineConfigurationSchema,
} from "@/contracts/silo"
import { onboardingSteps } from "@/features/onboarding/model/onboarding-state"

// Recovery stores unfinished input. Existing Save validation still decides
// whether these values can become a machine configuration.
const unfinishedMachineSchema = z.discriminatedUnion("kind", [
  z.object({ ...setupVirtualMachineConfigurationSchema.shape, name: z.string() }).strict(),
  setupSSHMachineConfigurationSchema.extend({
    name: z.string(), host: z.string(), user: z.string(), port: z.number(),
  }).strict(),
])

export const machineEditorDraftSchema = z.object({
  draft: unfinishedMachineSchema,
  originalID: z.uuid().optional(),
  insertAt: z.number().int().nonnegative(),
  displayAfterID: z.uuid().optional(),
}).strict()

export type MachineEditorDraft = z.infer<typeof machineEditorDraftSchema>

export const onboardingDraftSchema = z.object({
  currentStep: z.enum(onboardingSteps),
  machines: setupMachineConfigurationRequestSchema.shape.machines,
  unfinishedMachineEditor: machineEditorDraftSchema.nullable(),
  workspaceSelections: z.record(z.string(), z.array(z.object({
    repository: z.string(),
    allowPushes: z.boolean(),
  }).strict())),
  workspaceIdentities: z.record(z.string(), z.object({
    name: z.string(), email: z.string(), apply: z.boolean(),
  }).strict()),
}).strict().superRefine((draft, context) => {
  const result = setupMachineConfigurationRequestSchema.safeParse({ schemaVersion: 1, machines: draft.machines })
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue })
  }
})

export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>
