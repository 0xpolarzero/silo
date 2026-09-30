import type { ApplicationSecret, SecretConfigurationRequest } from "./application-source"
import reservedSecretNames from "./reserved-secret-names.json"

export interface SecretDraft {
  name: string
  value: string
  workspaces: string[]
  domains: string
  allowAnyDomain: boolean
}

export type SecretValidationErrors = Partial<Record<keyof SecretDraft, string>>

// The native secrets controller reads the same list, so both reject the same names.
const reservedNames = new Set<string>(reservedSecretNames.names)

function reservedName(name: string) {
  const upper = name.toUpperCase()
  return reservedNames.has(upper) || reservedSecretNames.prefixes.some((prefix) => upper.startsWith(prefix))
}

function validDomain(domain: string) {
  if (domain === "*") return true
  const wildcard = domain.startsWith("*.")
  const host = wildcard ? domain.slice(2) : domain
  const labels = host.split(".")
  return host.length <= 253 && (!wildcard || labels.length >= 2) && labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

export function secretConfiguration(draft: SecretDraft, secrets: readonly ApplicationSecret[], availableWorkspaces: readonly string[], original?: ApplicationSecret):
  { request: SecretConfigurationRequest; errors?: never } | { errors: SecretValidationErrors; request?: never } {
  const errors: SecretValidationErrors = {}
  const name = original?.name ?? draft.name.trim()
  const allowedDomains = [...new Set(draft.domains.split(/[\s,]+/).filter(Boolean).map((domain) => domain.toLowerCase()))]

  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    errors.name = "Use up to 128 letters, digits, or underscores, starting with a letter or underscore."
  } else if (reservedName(name)) {
    errors.name = "This name is reserved. Choose another name."
  } else if (secrets.some((secret) => secret.id !== original?.id && secret.name === name)) {
    errors.name = "A secret with this name already exists."
  }
  if (!original && !draft.value) errors.value = "Enter a value."
  if (draft.workspaces.length === 0) errors.workspaces = "Select at least one sandbox."
  else if (draft.workspaces.some((name) => !availableWorkspaces.includes(name))) errors.workspaces = "Select an available sandbox."
  if (allowedDomains.length === 0) errors.domains = "Enter at least one allowed domain."
  else if (!allowedDomains.every(validDomain)) errors.domains = "Use hosts such as api.example.com or *.example.com, without a scheme, port, or path."
  if (allowedDomains.includes("*") && !draft.allowAnyDomain) errors.allowAnyDomain = "Confirm access to any HTTPS destination."
  if (Object.keys(errors).length > 0) return { errors }

  const metadata = { name, workspaces: [...draft.workspaces], allowedDomains }
  return { request: original
    ? { ...metadata, operation: "edit", id: original.id, ...(draft.value ? { value: draft.value } : {}) }
    : { ...metadata, operation: "add", value: draft.value } }
}
