import { useEffect } from "react"
import type { ApplicationActions } from "../model/application-source"

export function useSshAccessRefresh(refresh: ApplicationActions["refreshSshAccess"], active = true) {
  useEffect(() => {
    if (!active || !refresh) return
    const update = (background = false) => { if (document.visibilityState !== "hidden") void refresh({ background }) }
    const onReturn = () => update()
    update()
    const timer = window.setInterval(() => update(true), 5000)
    window.addEventListener("focus", onReturn)
    document.addEventListener("visibilitychange", onReturn)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onReturn); document.removeEventListener("visibilitychange", onReturn) }
  }, [active, refresh])
}

