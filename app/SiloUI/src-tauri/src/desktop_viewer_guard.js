// Runs in every frame of the guest desktop webview before its own scripts
// (G-20). Guest pages are sandbox content, and every click on the desktop is a
// user gesture, so they must not reach this computer's clipboard. Clipboard
// sharing is already off in Selkies (--enable-clipboard=false).
(() => {
  const refuse = () => Promise.reject(new DOMException("Sandbox desktops cannot use this computer's clipboard.", "NotAllowedError"))
  const lock = (target, name, value) => {
    try { Object.defineProperty(target, name, { value, configurable: false, writable: false }) } catch { /* already locked */ }
  }
  if (typeof Clipboard !== "undefined") {
    for (const name of ["read", "readText", "write", "writeText"]) lock(Clipboard.prototype, name, refuse)
  }
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (clipboard) {
    for (const name of ["read", "readText", "write", "writeText"]) lock(clipboard, name, refuse)
  }
  if (typeof Document !== "undefined") {
    const execCommand = Document.prototype.execCommand
    lock(Document.prototype, "execCommand", function (command, ...rest) {
      return /^(copy|cut|paste)$/i.test(String(command)) ? false : execCommand.call(this, command, ...rest)
    })
  }
  // Page handlers could replace the copied data; the user's own selection is
  // still copied by the default action. Pasting stays the user's choice.
  for (const type of ["copy", "cut"]) {
    window.addEventListener(type, event => event.stopImmediatePropagation(), true)
  }
})()
