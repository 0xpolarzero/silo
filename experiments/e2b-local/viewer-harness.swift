// Disposable WebKit compatibility test. No Silo application IPC or UI changes.
import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let executableDirectory = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let savedURL = executableDirectory.appendingPathComponent("viewer-harness-url.txt")
let urlText = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : (try? String(contentsOf: savedURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))
guard let urlText, let viewerURL = URL(string: urlText) else {
    fatalError("Supply a viewer URL argument or adjacent viewer-harness-url.txt")
}
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1280, height: 840),
                      styleMask: [.titled, .closable, .resizable, .miniaturizable],
                      backing: .buffered, defer: false)
window.title = "Silo E2B Viewer Qualification"
let browser = WKWebView(frame: window.contentView!.bounds)
browser.autoresizingMask = [.width, .height]
window.contentView = browser
window.makeKeyAndOrderFront(nil)
browser.load(URLRequest(url: viewerURL))
app.activate(ignoringOtherApps: true)
app.run()
