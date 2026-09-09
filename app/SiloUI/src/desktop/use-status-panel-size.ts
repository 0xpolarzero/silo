import { useEffect, type RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

export function useStatusPanelSize(content: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      void invoke("resize_status", { height: element.getBoundingClientRect().height }).catch(console.error)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [content])
}

