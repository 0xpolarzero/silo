import { useSyncExternalStore } from "react"

export type Theme = "system" | "dark" | "light"
const storageKey = "silo-theme"
const subscribers = new Set<() => void>()

function parseTheme(value: string | null): Theme {
  return value === "dark" || value === "light" ? value : "system"
}

function readTheme(): Theme {
  try { return parseTheme(localStorage.getItem(storageKey)) }
  catch { return "system" }
}

let theme = readTheme()
const getTheme = () => theme

function subscribe(listener: () => void) {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

function notify() { subscribers.forEach((listener) => listener()) }

function setTheme(value: string) {
  theme = parseTheme(value)
  try { localStorage.setItem(storageKey, theme) }
  catch { /* Keep the selection usable for this session when storage is unavailable. */ }
  notify()
}

export function useTheme() {
  return { theme: useSyncExternalStore(subscribe, getTheme), setTheme }
}

// Initialize before React renders, in both the main window and the status panel.
export function initializeTheme() {
  theme = readTheme()
  const system = window.matchMedia("(prefers-color-scheme: dark)")
  function apply() {
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && system.matches))
  }
  function sync(event: StorageEvent) {
    if (event.storageArea === localStorage && (event.key === storageKey || event.key === null)) {
      theme = readTheme()
      notify()
    }
  }
  apply()
  const unsubscribe = subscribe(apply)
  system.addEventListener("change", apply)
  window.addEventListener("storage", sync)
  return () => {
    unsubscribe()
    system.removeEventListener("change", apply)
    window.removeEventListener("storage", sync)
  }
}
