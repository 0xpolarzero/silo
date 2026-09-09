import { describe, expect, it } from "vitest"

import { secretConfiguration, type SecretDraft } from "./secret-configuration"

const draft: SecretDraft = { name: "SERVICE_TOKEN", value: "fixture-token", workspaces: ["dev"], domains: "api.example.test", allowAnyDomain: false }

describe("secret configuration", () => {
  it.each(["9TOKEN", "SERVICE-TOKEN", "TOKEN".repeat(26), "PATH", "SSL_CERT_FILE", "http_proxy", "SILO_TOKEN", "MSB_TOKEN", "msb_token", "rust_log", "path", "DYLD_INSERT_LIBRARIES"])("rejects invalid or reserved name %s", (name) => {
    expect(secretConfiguration({ ...draft, name }, [], ["dev"]).errors?.name).toBeDefined()
  })

  it.each(["https://api.example.test", "api.example.test:443", "api.example.test/path", "*.com", "a.*.test", "-api.example.test", "api..test", `${"a".repeat(64)}.test`])("rejects invalid domain %s", (domains) => {
    expect(secretConfiguration({ ...draft, domains }, [], ["dev"]).errors?.domains).toBeDefined()
  })

  it("rejects sandbox selections that are no longer available", () => {
    expect(secretConfiguration(draft, [], ["personal"]).errors?.workspaces).toBe("Select an available sandbox.")
  })
})
