import { useState } from "react"
import { Accessibility, Paintbrush, Power } from "lucide-react"

import { ListCard, ListRow, ListRowDetails, ListRowIcon } from "@/components/list-row"
import { FilterCombobox } from "@/components/filter-combobox"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ApplicationSource } from "@/features/application/model/application-source"
import { ApplicationPreferenceFields } from "@/features/preferences/components/application-preference-fields"
import type { ApplicationPreferenceSelection } from "@/features/preferences/model/application-preferences"
import { useTheme } from "@/features/preferences/theme"

function SettingRow({ icon: Icon, title, description, control }: { icon: typeof Power; title: string; description: string; control: React.ReactNode }) {
  return (
    <ListRow
      className="hover:bg-muted/35 focus-within:bg-muted/35"
      icon={<ListRowIcon aria-hidden="true"><Icon className="size-3.5" /></ListRowIcon>}
      title={<h4>{title}</h4>}
      detail={description}
      detailClassName="whitespace-normal"
      actions={control}
    />
  )
}

export function GeneralPage({
  source,
  applicationPreferences,
  onApplicationPreferencesChange,
  reduceMotion,
  onReduceMotionChange,
}: {
  source: ApplicationSource
  applicationPreferences: ApplicationPreferenceSelection
  onApplicationPreferencesChange: (preferences: ApplicationPreferenceSelection) => void
  reduceMotion: boolean
  onReduceMotionChange: (enabled: boolean) => void
}) {
  const { theme, setTheme } = useTheme()
  const [launchAtLogin, setLaunchAtLogin] = useState(source.preferences.launchAtLogin)
  const [startAtLaunch, setStartAtLaunch] = useState(source.preferences.startWorkspacesAtLaunch)
  const [startupWorkspaces, setStartupWorkspaces] = useState<Set<string>>(() => {
    const initial = source.workspaces.find(({ machine }) => machine.name === "dev") ?? source.workspaces[0]
    return new Set(initial ? [initial.machine.id] : [])
  })

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-5 sm:px-6 sm:py-6">
      <h2 className="text-xs font-medium">General</h2>
      <section className="grid gap-2">
        <h3 className="text-xs font-medium">Appearance</h3>
        <ListCard>
          <SettingRow icon={Paintbrush} title="Theme" description="Choose an appearance or follow your system." control={
            <div className="w-40 max-w-[45%] shrink-0">
              <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger className="h-7 text-[11px]" aria-label="Theme"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
            </div>
          } />
        </ListCard>
      </section>
      <section className="grid gap-2">
        <h3 className="text-xs font-medium">Startup</h3>
        <ListCard divided>
          <SettingRow icon={Power} title="Launch Silo at login" description="Keep workspace status and notifications available." control={<Switch checked={launchAtLogin} onCheckedChange={setLaunchAtLogin} aria-label="Launch Silo at login" />} />
          <div>
            <SettingRow icon={Power} title="Start sandboxes at launch" description="Start selected sandboxes when Silo opens." control={<Switch checked={startAtLaunch} onCheckedChange={setStartAtLaunch} aria-label="Start sandboxes at launch" />} />
            {startAtLaunch && (
              <ListRowDetails label="Sandboxes to start at launch" className="gap-2">
                <FilterCombobox
                  options={source.workspaces.map(({ machine }) => ({ value: machine.id, label: machine.name }))}
                  selectedValues={startupWorkspaces}
                  onChange={setStartupWorkspaces}
                  label="Startup sandboxes"
                  inputLabel="Add sandbox at startup"
                  placeholder="Select sandboxes…"
                  listLabel="Available startup sandboxes"
                  selectedLabel="Selected startup sandboxes"
                  emptyMessage="No sandboxes available."
                />
              </ListRowDetails>
            )}
          </div>
        </ListCard>
      </section>
      <section className="grid gap-2">
        <h3 className="text-xs font-medium">Applications</h3>
        <ListCard divided>
          <ApplicationPreferenceFields compact value={applicationPreferences} onChange={onApplicationPreferencesChange} />
        </ListCard>
      </section>
      <section className="grid gap-2">
        <h3 className="text-xs font-medium">Accessibility</h3>
        <ListCard><SettingRow icon={Accessibility} title="Reduce motion" description="Disable nonessential interface animation." control={<Switch checked={reduceMotion} onCheckedChange={onReduceMotionChange} aria-label="Reduce motion" />} /></ListCard>
      </section>
    </div>
  )
}
