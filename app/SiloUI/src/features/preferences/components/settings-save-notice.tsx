import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useSettings } from "@/features/preferences/settings-store"

export function SettingsSaveNotice() {
  const { store, saveError, writeProtected } = useSettings()
  const [saving, setSaving] = useState(false)
  if (!saveError) return null
  return <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/[.06] p-3 text-xs">
    <p>{writeProtected ? "Settings are protected from writes. Changes last for this session." : "Settings could not be saved. Keep Silo open and retry."}</p>
    <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{saveError}</p>
    {!writeProtected && <Button type="button" size="xs" variant="outline" className="mt-2" disabled={saving} onClick={() => {
      setSaving(true)
      void store.flush().finally(() => setSaving(false))
    }}>{saving ? "Saving settings…" : "Retry saving settings"}</Button>}
  </div>
}
