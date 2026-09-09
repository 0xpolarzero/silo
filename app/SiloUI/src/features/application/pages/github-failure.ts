// Runtime output can contain environment values and credentials. Describe known
// failures without forwarding arbitrary command output to the UI or clipboard.
export function githubFailure(message: string) {
  if (message === "Invalid Git identity settings.") {
    return { message, details: "Enter a Git name and email, or turn off Apply if you do not want Silo to set the sandbox identity.", canRetry: false }
  }
  if (message.includes("Recreate this development sandbox")) {
    return {
      message: "This sandbox needs a new setup for GitHub access.",
      details: "GitHub access: this sandbox was created without the current GitHub integration. Restarting Silo or retrying cannot add it. Create a new sandbox; preserve any files you need before deleting the old one."
        + (message.includes("requires restart") ? "\n\nGit identity: this sandbox also has old startup identity settings. Removing them requires a sandbox restart. A restart alone does not resolve the GitHub integration issue." : ""),
      canRetry: false,
    }
  }
  if (message.includes("requires restart")) {
    return {
      message: "Restart this sandbox to update its Git identity.",
      details: "Old startup identity settings cannot be removed while the sandbox is running. Stop the sandbox, retry the identity change, then start it again. Save your work before stopping it.",
      canRetry: false,
    }
  }
  if (message.includes("git: not found")) {
    return {
      message: "Git is missing from this sandbox.",
      details: "Git identity could not be saved because Git is not installed inside the sandbox. Retrying cannot resolve the missing installation.",
      canRetry: false,
    }
  }
  return {
    message: "GitHub settings couldn’t be applied.",
    details: "Silo could not verify the requested GitHub settings for this sandbox. Retry to apply them again. Technical command output is omitted because it can contain private values.",
    canRetry: true,
  }
}
