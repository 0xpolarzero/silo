import { useEffect, useId, useRef, useState } from "react"
import { KeyRound } from "lucide-react"

import { FilterCombobox } from "@/components/filter-combobox"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import type { ApplicationSecret, ApplicationSource, SecretConfigurationRequest } from "../model/application-source"
import { secretConfiguration, type SecretDraft, type SecretValidationErrors } from "../model/secret-configuration"

export function SecretEditor({ secret, source, onSave, onCancel }: {
  secret?: ApplicationSecret
  source: ApplicationSource
  onSave: (request: SecretConfigurationRequest) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<SecretDraft>(() => ({
    name: secret?.name ?? "", value: "", workspaces: secret?.workspaces ?? [],
    domains: secret?.allowedDomains.join(", ") ?? "", allowAnyDomain: secret?.allowedDomains.includes("*") ?? false,
  }))
  const [errors, setErrors] = useState<SecretValidationErrors>({})
  const formRef = useRef<HTMLFormElement>(null)
  const id = useId()
  const workspaces = source.workspaces.filter(({ machine }) => machine.kind === "vm")
  const title = secret ? `Edit ${secret.name}` : "Add secret"
  const anyDomain = draft.domains.split(/[\s,]+/).includes("*")

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus()
  }, [])
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errors])

  function update(changes: Partial<SecretDraft>) {
    setDraft((current) => ({ ...current, ...changes }))
    setErrors({})
  }

  function fieldError(field: keyof SecretDraft) {
    return errors[field] && <span id={`${id}-${field}-error`} className="text-[11px] text-destructive" role="alert">{errors[field]}</span>
  }

  return <form ref={formRef} aria-label={title} className="grid min-w-0 gap-3 p-3" noValidate onSubmit={(event) => {
    event.preventDefault()
    const result = secretConfiguration(draft, source.secrets, workspaces.map(({ machine }) => machine.name), secret)
    if (result.errors) {
      setErrors(result.errors)
      return
    }
    const request = result.request
    const unchanged = secret && request.value === undefined
      && request.workspaces.length === secret.workspaces.length && request.workspaces.every((name) => secret.workspaces.includes(name))
      && request.allowedDomains.length === secret.allowedDomains.length && request.allowedDomains.every((domain) => secret.allowedDomains.includes(domain))
    if (unchanged) onCancel()
    else onSave(request)
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }}>
    <h3 className="flex min-w-0 items-center gap-2 text-xs font-semibold"><KeyRound className="size-4 shrink-0" aria-hidden="true" /><span className="break-all">{title}</span></h3>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="grid content-start gap-1">
        <label htmlFor={`${id}-name`} className="text-[11px] font-medium text-muted-foreground">Name</label>
        <Input id={`${id}-name`} value={draft.name} disabled={Boolean(secret)} autoComplete="off" spellCheck={false} autoCapitalize="off" className="font-mono text-xs md:text-xs" placeholder="SERVICE_TOKEN" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `${id}-name-error` : undefined} onChange={(event) => update({ name: event.target.value })} />
        {fieldError("name")}
      </div>
      <div className="grid content-start gap-1">
        <label htmlFor={`${id}-value`} className="text-[11px] font-medium text-muted-foreground">{secret ? "Replacement value" : "Value"}</label>
        <Input id={`${id}-value`} type="password" value={draft.value} autoComplete="new-password" spellCheck={false} autoCapitalize="off" className="text-xs md:text-xs" aria-invalid={Boolean(errors.value)} aria-describedby={errors.value ? `${id}-value-error` : secret ? `${id}-value-hint` : undefined} onChange={(event) => update({ value: event.target.value })} />
        {secret && <p id={`${id}-value-hint`} className="text-[11px] text-muted-foreground">Leave blank to keep the current value.</p>}
        {fieldError("value")}
      </div>
    </div>
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-2 text-[11px] font-medium text-muted-foreground">Sandboxes</legend>
      <FilterCombobox
        options={workspaces.map(({ machine }) => ({ value: machine.name, label: machine.name }))}
        selectedValues={new Set(draft.workspaces)}
        onChange={(values) => update({ workspaces: [...values] })}
        label="Secret sandboxes"
        inputLabel="Add sandbox"
        placeholder="Select sandboxes…"
        listLabel="Available sandboxes"
        selectedLabel="Selected sandboxes"
        emptyMessage={workspaces.length === 0 ? "Add a virtual machine to assign secrets." : "No sandboxes available."}
        inputInvalid={Boolean(errors.workspaces)}
        inputDescribedBy={errors.workspaces ? `${id}-workspaces-error` : undefined}
      />
      {fieldError("workspaces")}
    </fieldset>
    <div className="grid gap-1">
      <label htmlFor={`${id}-domains`} className="text-[11px] font-medium text-muted-foreground">Allowed domains</label>
      <Input id={`${id}-domains`} value={draft.domains} autoComplete="off" spellCheck={false} autoCapitalize="off" className="text-xs md:text-xs" placeholder="api.example.com, *.example.com" aria-invalid={Boolean(errors.domains)} aria-describedby={`${id}-domains-hint${errors.domains ? ` ${id}-domains-error` : ""}`} onChange={(event) => update({ domains: event.target.value, allowAnyDomain: false })} />
      <p id={`${id}-domains-hint`} className="text-[11px] text-muted-foreground">Separate hosts with commas. Use * to allow any HTTPS destination.</p>
      {fieldError("domains")}
    </div>
    {anyDomain && <div className="grid gap-2 rounded-md bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400">
      <p>Any HTTPS server could receive this secret.</p>
      <label className="flex items-center gap-2"><Checkbox checked={draft.allowAnyDomain} aria-invalid={Boolean(errors.allowAnyDomain)} aria-describedby={errors.allowAnyDomain ? `${id}-allowAnyDomain-error` : undefined} onCheckedChange={(checked) => update({ allowAnyDomain: checked === true })} />Allow any HTTPS destination</label>
      {fieldError("allowAnyDomain")}
    </div>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      <Button type="submit" size="sm">Save</Button>
    </div>
  </form>
}
