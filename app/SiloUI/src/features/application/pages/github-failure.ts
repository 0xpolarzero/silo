// Runtime output can contain environment values and credentials. Describe known
// failures without forwarding arbitrary command output to the UI or clipboard.
export function githubFailure(message: string) {
  if (message === "Invalid Git identity settings.") {
    return { message, details: "Enter a Git name and email, or turn off Apply if you do not want Silo to set the computer identity.", canRetry: false }
  }
  if (message.includes("Recreate this development computer")) {
    return {
      message: "This computer needs a new setup for GitHub access.",
      details: "GitHub access: this computer was created without the current GitHub integration. Restarting Silo or retrying cannot add it. Create a new computer; preserve any files you need before deleting the old one."
        + (message.includes("requires restart") ? "\n\nGit identity: this computer also has old startup identity settings. Removing them requires a computer restart. A restart alone does not resolve the GitHub integration issue." : ""),
      canRetry: false,
    }
  }
  if (message.includes("requires restart")) {
    return {
      message: "Restart this computer to update its Git identity.",
      details: "Old startup identity settings cannot be removed while the computer is running. Stop the computer, retry the identity change, then start it again. Save your work before stopping it.",
      canRetry: false,
    }
  }
  if (message.includes("git: not found")) {
    return {
      message: "Git is missing from this computer.",
      details: "Git identity could not be saved because Git is not installed inside the computer. Retrying cannot resolve the missing installation.",
      canRetry: false,
    }
  }
  return {
    message: "GitHub settings could not be applied.",
    details: "Silo could not verify the requested GitHub settings for this computer. Retry to apply them again. Technical command output is omitted because it can contain private values.",
    canRetry: true,
  }
}
