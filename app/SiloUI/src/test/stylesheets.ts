// jsdom matches every rule of every stylesheet in the document for each computed
// style, and Testing Library computes styles for most queries. These helpers keep
// rules out of the document when no element in it can match them, without
// changing any style a test can observe. Measurements:
// docs/SiloUI-FRONTEND-TEST-PERFORMANCE.md (K-09).

/**
 * jsdom 29 keeps the stylesheet of a `<style>` element that leaves the document
 * inside a removed subtree (for example Radix ScrollArea's inline style): while
 * detaching, the element still reads its stale cached root as the document and
 * re-adds its sheet. Those sheets accumulate for the rest of the test file.
 * Re-running the element's style-block update now that it is disconnected
 * removes the sheet.
 */
export function purgeDetachedStyleSheets(document: Document) {
  for (const sheet of [...document.styleSheets]) {
    const owner = sheet.ownerNode
    if (owner instanceof document.defaultView!.HTMLStyleElement && !owner.isConnected) {
      // Changing the text runs the update again; the element keeps the same CSS.
      const css = owner.textContent
      owner.textContent = css
    }
  }
}

/**
 * Sonner inserts its stylesheet (about 100 rules) into `<head>` when imported.
 * Apart from custom properties on `html[dir]`, every rule targets the toast list,
 * which Sonner renders as `<ol data-sonner-toaster>` only while toasts exist.
 * Keep the sheet in the document exactly while such a list exists, checked
 * before every `getComputedStyle` call, so toast assertions still see Sonner's
 * real CSS and every other query skips its rules.
 */
export function gateSonnerStyleSheet(window: Window & typeof globalThis) {
  const { document } = window
  const style = [...document.head.querySelectorAll("style")].find((element) => element.textContent?.includes("[data-sonner-toaster]"))
  if (!style) return
  // A live collection is re-read only after the document changes.
  const lists = document.getElementsByTagName("ol")
  const getComputedStyle = window.getComputedStyle.bind(window)
  style.remove()
  window.getComputedStyle = (element, pseudoElement) => {
    const toasts = Array.prototype.some.call(lists, (list: Element) => list.hasAttribute("data-sonner-toaster"))
    // Sonner inserts its sheet before any component CSS; prepend to keep that cascade order.
    if (toasts && !style.isConnected) document.head.prepend(style)
    else if (!toasts && style.isConnected) style.remove()
    return getComputedStyle(element, pseudoElement)
  }
}
