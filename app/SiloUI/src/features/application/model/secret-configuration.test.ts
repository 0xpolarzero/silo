import { describe, expect, it } from "vitest"

import { applicationSourceForScenario } from "@/fixtures/application-scenarios"
import { secretConfiguration, type SecretDraft } from "./secret-configuration"

const draft: SecretDraft = { name: "SERVICE_TOKEN", value: "fixture-token", computers: ["dev"], domains: "api.example.test", allowAnyDomain: false }

describe("secret configuration", () => {
  it.each([
    { label: "oversized ASCII", value: "a".repeat(65537) },
    { label: "oversized UTF-8", value: "é".repeat(32769) },
    { label: "null-containing", value: "token\0value" },
  ])("rejects $label values for new secrets and replacements", ({ value }) => {
    const original = applicationSourceForScenario("running").secrets[0]
    expect(secretConfiguration({ ...draft, value }, [], ["dev"]).errors?.value).toBeDefined()
    expect(secretConfiguration({ ...draft, value }, [original], ["dev"], original).errors?.value).toBeDefined()
  })

  it.each([
    { label: "ASCII", value: "a".repeat(65536) },
    { label: "UTF-8", value: "é".repeat(32768) },
  ])("accepts a $label value at the native UTF-8 byte limit", ({ value }) => {
    const result = secretConfiguration({ ...draft, value }, [], ["dev"])
    expect(result.request?.value).toHaveLength(value.length)
  })

  it.each([100, 101])("checks the native limit for %i computer assignments", count => {
    const computers = Array.from({ length: count }, (_, index) => `vm-${index}`)
    const result = secretConfiguration({ ...draft, computers }, [], computers)
    if (count === 100) expect(result.request?.computers).toHaveLength(count)
    else expect(result.errors?.computers).toBeDefined()
  })

  it.each([100, 101])("checks the native limit for %i allowed domains", count => {
    const domains = Array.from({ length: count }, (_, index) => `api-${index}.example.test`).join(", ")
    const result = secretConfiguration({ ...draft, domains }, [], ["dev"])
    if (count === 100) expect(result.request?.allowedDomains).toHaveLength(count)
    else expect(result.errors?.domains).toBeDefined()
  })

  it.each(["localhost", "127.0.0.1", "*.co.uk", "*.github.io", "xn--bcher-kva.example"])("allows the host policy's supported destination %s", domains => {
    expect(secretConfiguration({ ...draft, domains }, [], ["dev"]).request?.allowedDomains).toEqual([domains])
  })

  it.each([[128, true], [129, false]] as const)("enforces the secret name limit at %i characters", (length, valid) => {
    const result = secretConfiguration({ ...draft, name: "A".repeat(length) }, [], ["dev"])
    if (valid) expect(result.request?.name).toBe("A".repeat(length))
    else expect(result.errors?.name).toBeDefined()
  })

  it.each([[61, true], [62, false]] as const)("enforces total host length with a final label of %i characters", (lastLength, valid) => {
    const domains = [...Array<string>(3).fill("a".repeat(63)), "b".repeat(lastLength)].join(".")
    expect(domains).toHaveLength(valid ? 253 : 254)
    const result = secretConfiguration({ ...draft, domains }, [], ["dev"])
    if (valid) expect(result.request?.allowedDomains).toEqual([domains])
    else expect(result.errors?.domains).toBeDefined()
  })

  it("preserves the saved identity when an edit supplies another name and leaves the value blank", () => {
    const original = applicationSourceForScenario("running").secrets[0]
    const result = secretConfiguration({ ...draft, name: "PATH", value: "" }, [original], ["dev"], original)
    expect(result.request).toEqual({
      operation: "edit", id: original.id, name: original.name,
      computers: ["dev"], allowedDomains: ["api.example.test"],
    })
    expect(result.request).not.toHaveProperty("value")
  })

  it.each(["9TOKEN", "SERVICE-TOKEN", "TOKEN".repeat(26), "PATH", "SSL_CERT_FILE", "http_proxy", "SILO_TOKEN", "MSB_TOKEN", "msb_token", "rust_log", "path", "DYLD_INSERT_LIBRARIES"])("rejects invalid or reserved name %s", (name) => {
    expect(secretConfiguration({ ...draft, name }, [], ["dev"]).errors?.name).toBeDefined()
  })

  it.each(["https://api.example.test", "api.example.test:443", "api.example.test/path", "*.com", "a.*.test", "-api.example.test", "api..test", `${"a".repeat(64)}.test`])("rejects invalid domain %s", (domains) => {
    expect(secretConfiguration({ ...draft, domains }, [], ["dev"]).errors?.domains).toBeDefined()
  })

  it("rejects computer selections that are no longer available", () => {
    expect(secretConfiguration(draft, [], ["personal"]).errors?.computers).toBe("Select an available computer.")
  })
})
