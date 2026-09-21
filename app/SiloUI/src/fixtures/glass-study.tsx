import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Moon, Sun, MoveHorizontal } from "lucide-react"
import { FixtureApp } from "./fixture-app"
import "../index.css"
import "./glass-study.css"

// Separate browser-only entry: never imported by the native application.
const url = new URL(window.location.href)
url.searchParams.set("view", "app")
url.searchParams.set("scenario", "complete")
window.history.replaceState(null, "", url)
const initialMaterial = url.searchParams.get("material")
const initialDark = url.searchParams.get("appearance") === "dark"
document.documentElement.classList.toggle("dark", initialDark)
const chromium = /Chrome|Chromium|Edg\//.test(navigator.userAgent)

export function GlassStudy() {
  const [mode, setMode] = useState(initialMaterial === "original" || initialMaterial === "frosted" ? initialMaterial : "glass")
  const [dark, setDark] = useState(initialDark)
  const [strength, setStrength] = useState(18)
  const [shift, setShift] = useState(false)
  const [refraction, setRefraction] = useState(chromium)
  return <div className="glass-study" data-material={mode} data-shift={shift} data-refraction={refraction}>
    <svg className="glass-filter" aria-hidden="true" width="0" height="0"><defs>
      <filter id="silo-refraction" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="7" result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2" result="smoothNoise" />
        <feDisplacementMap in="SourceGraphic" in2="smoothNoise" scale={strength} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </defs></svg>
    <header className="study-heading"><div><span className="study-eyebrow">SILO / MATERIAL STUDY 01</span><h1>A little more depth.</h1><p>The same workspace, seen through glass.</p></div><span className="study-tag">Interactive concept · Fixture data</span></header>
    <div className="study-wallpaper" aria-hidden="true"><div className="study-ribbon"/><div className="study-orbit"/><div className="study-orbit second"/></div>
    <FixtureApp />
    <footer className="study-controls">
      <div className="study-segment" aria-label="Surface material">{["original", "frosted", "glass"].map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "original" ? "Current UI" : value === "frosted" ? "Frosted" : "Refractive"}</button>)}</div>
      <span className="study-control-divider" />
      <label className="study-slider">Refraction <input aria-label="Refraction strength" type="range" min="0" max="60" value={strength} disabled={mode !== "glass" || !refraction} onChange={event => setStrength(Number(event.target.value))}/><output>{strength}</output></label>
      <button className="study-icon-button" aria-label="Move backdrop" aria-pressed={shift} onClick={() => setShift(!shift)}><MoveHorizontal size={17}/></button>
      <button className="study-icon-button" aria-label={dark ? "Use light appearance" : "Use dark appearance"} onClick={() => {setDark(!dark); document.documentElement.classList.toggle("dark", !dark)}}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button>
    </footer>
    <p className="study-caption">{mode === "original" ? "Silo’s existing surfaces and spacing." : mode === "frosted" ? "Translucency, blur and a fine lit edge. No displacement." : "Soft refraction in the shell. Quiet, readable surfaces for your work."} <label><input type="checkbox" checked={refraction} disabled={!chromium} onChange={event => setRefraction(event.target.checked)}/> SVG displacement {chromium ? "(Chromium preview)" : "unavailable here; frosted fallback"}</label></p>
  </div>
}
createRoot(document.getElementById("root")!).render(url.searchParams.get("production") === "1" ? <FixtureApp /> : <GlassStudy />)
