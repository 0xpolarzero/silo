import { useState } from "react"
import { Check, KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ListCard, ListRow, ListRowIcon } from "@/components/list-row"
import { showActionFailure } from "@/lib/operation-toast"
import type { ApplicationSource } from "@/features/application/model/application-source"

export function PersonalTokenConnection({ status, onSave, onRemove }: {
  status?: ApplicationSource["github"]["personalToken"]
  onSave?: (token: string) => Promise<void>
  onRemove?: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const connected = status?.state === "connected"
  async function save() {
    if (!onSave || !token.trim()) return
    const value = token.trim()
    setToken("")
    setBusy(true)
    try { await onSave(value); setEditing(false) }
    catch { showActionFailure("Could not connect token", "Check its validity, your connection, and credential-store access.", undefined, { native: false }) }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!onRemove) return
    setBusy(true)
    try { await onRemove(); setEditing(false); setToken("") }
    catch { showActionFailure("Could not remove token", "Check credential-store access and try again.", () => void remove(), { native: false }) }
    finally { setBusy(false) }
  }
  return <ListCard className="shrink-0">
    <ListRow icon={<ListRowIcon>{busy ? <Loader2 className="size-3.5 animate-spin" /> : connected ? <Check className="size-3.5 text-emerald-600" /> : <KeyRound className="size-3.5" />}</ListRowIcon>}
      title={<h3 className="text-sm">{connected ? `Token connected as @${status.account}` : "Personal access token"}</h3>}
      detail={status?.message ?? (connected ? "Available to sandboxes that select Use token." : "Connect a token with the GitHub permissions you choose.")}
      actions={<div className="flex gap-1">
        <Button size="xs" variant="outline" disabled={busy || !onSave} onClick={() => { setEditing(true) }}>{status?.saved ? "Replace token" : "Add token"}</Button>
        {status?.saved && <Button size="xs" variant="ghost" disabled={busy || !onRemove} onClick={() => void remove()}>Remove token</Button>}
      </div>} />
    {editing && <form className="flex flex-wrap gap-2 border-t p-3" onSubmit={event => { event.preventDefault(); void save() }}>
      <Input technical className="min-w-40 flex-1" type="password" aria-label="GitHub personal access token" autoComplete="off" spellCheck={false}
        value={token} disabled={busy} onChange={event => setToken(event.target.value)} placeholder="Paste your personal access token" />
      <Button size="sm" type="submit" disabled={busy || !token.trim()}>Connect token</Button>
      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { setEditing(false); setToken("") }}>Cancel</Button>
    </form>}
  </ListCard>
}
