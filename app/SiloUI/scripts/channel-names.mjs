// Read the same Rust API used by Python packaging scripts.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const result = spawnSync("python3", [fileURLToPath(new URL("./channel_names.py", import.meta.url))], { encoding: "utf8" })
if (result.error || result.status !== 0) {
  throw new Error("Could not read channel.rs. Install Rust and Python 3.11 or newer before running this script.", { cause: result.error })
}
const names = JSON.parse(result.stdout)
const freeze = channel => Object.freeze({ ...channel, keychain: Object.freeze(channel.keychain) })
export const PRODUCTION = freeze(names.production)
export const DEVELOPMENT = freeze(names.development)
