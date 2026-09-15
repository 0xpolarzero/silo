import { useEffect } from "react"
import type { ApplicationActions } from "../model/application-source"

export function useSshAccessRefresh(refresh: ApplicationActions["refreshSshAccess"], active = true) {
  useEffect(() => {
    if (!active || !refresh) return
    const update = () => { if (document.visibilityState !== "hidden") void refresh() }
    update()
    const timer = window.setInterval(update, 5000)
    window.addEventListener("focus", update)
    document.addEventListener("visibilitychange", update)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update) }
  }, [active, refresh])
}

