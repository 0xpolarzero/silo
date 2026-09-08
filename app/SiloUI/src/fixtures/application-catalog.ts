import type { ApplicationCatalog } from "@/features/preferences/application-catalog"

export const fixtureApplicationCatalog: ApplicationCatalog = {
  terminal: ["Terminal", "iTerm", "Warp"].map((name) => ({ name, path: `/fixture/${name}.app` })),
  editor: ["Visual Studio Code", "Cursor", "Zed"].map((name) => ({ name, path: `/fixture/${name}.app` })),
  browser: ["Safari", "Google Chrome", "Firefox"].map((name) => ({ name, path: `/fixture/${name}.app` })),
  defaults: { terminal: "/fixture/Terminal.app", editor: "/fixture/Visual Studio Code.app", browser: "/fixture/Safari.app" },
}
