import type { ReactNode } from "react"
import { ComputerUseContext, type ComputerUseBridge } from "./computer-use-bridge"

/** Its presence means this build creates computers with the built-in desktop. */
export function ComputerUseProvider({ bridge, children }: { bridge: ComputerUseBridge; children: ReactNode }) {
  return <ComputerUseContext.Provider value={bridge}>{children}</ComputerUseContext.Provider>
}

