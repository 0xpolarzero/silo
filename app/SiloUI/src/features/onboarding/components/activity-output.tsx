import { useMemo } from "react"

import { LogDisclosure } from "@/components/log-disclosure"
import type { SiloProgressEvent } from "@/contracts/silo"

function eventLine(event: SiloProgressEvent): string {
  return [event.phase, event.workspace, event.message].filter(Boolean).join("  ")
}

export function ActivityOutput({ events, embedded = false }: { events: SiloProgressEvent[]; embedded?: boolean }) {
  const output = useMemo(() => events.map(eventLine).join("\n"), [events])
  return <LogDisclosure
    title="Live activity"
    output={output}
    outputLabel="Sandbox activity"
    controlsLabel="Live activity controls"
    emptyMessage="No activity yet."
    embedded={embedded}
    labels={{ expand: "Expand activity", collapse: "Collapse activity", copy: "Copy activity", copied: "Activity copied", copyFailed: "Copy activity failed" }}
  />
}
