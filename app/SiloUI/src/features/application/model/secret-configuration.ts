import type { ApplicationSecret, SecretConfigurationRequest } from "./application-source"

export interface SecretDraft {
  name: string
  value: string
  workspaces: string[]
  domains: string
  allowAnyDomain: boolean
}

export type SecretValidationErrors = Partial<Record<keyof SecretDraft, string>>

// Keep name validation aligned with the native secrets controller.
const reservedNames = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "IFS", "CDPATH", "GLOBIGNORE", "HOSTNAME", "HOSTALIASES",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "GIT_CONFIG_NOSYSTEM",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
])

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
  } else if (reservedNames.has(name.toUpperCase()) || /^(DYLD_|LD_|SILO_|MSB_|RUST_)/.test(name.toUpperCase())) {
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
