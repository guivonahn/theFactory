import AppKit
import SwiftUI

enum FactoryIcon {
    static var image: NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            NSColor.labelColor.setFill()
            let factory = NSBezierPath()
            factory.move(to: NSPoint(x: 1, y: 2))
            factory.line(to: NSPoint(x: 1, y: 14))
            factory.line(to: NSPoint(x: 5, y: 14))
            factory.line(to: NSPoint(x: 5, y: 8))
            factory.line(to: NSPoint(x: 10, y: 11))
            factory.line(to: NSPoint(x: 10, y: 8))
            factory.line(to: NSPoint(x: 15, y: 11))
            factory.line(to: NSPoint(x: 15, y: 8))
            factory.line(to: NSPoint(x: 19, y: 10))
            factory.line(to: NSPoint(x: 19, y: 2))
            factory.close()
            factory.fill()
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.compositingOperation = .clear
            for x in [4, 9, 14] { NSBezierPath(rect: NSRect(x: x, y: 4, width: 2, height: 2)).fill() }
            NSGraphicsContext.restoreGraphicsState()
            NSColor.labelColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: 3, y: 16, width: 3, height: 1.5)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let store = SessionStore()
    private let launcher = SessionLauncher()
    private var item: NSStatusItem!
    private let popover = NSPopover()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A second launch should reveal the existing companion instead of duplicating it.
        if let bundleID = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [])
            NSApp.terminate(nil)
            return
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = FactoryIcon.image
        item.button?.imagePosition = .imageLeading
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.setAccessibilityLabel("theFactory. Show agent progress.")
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        let availableHeight = (NSScreen.main?.visibleFrame.height ?? 800) - 50
        let height = min(610, max(420, availableHeight))
        popover.contentSize = NSSize(width: 380, height: height)
        popover.contentViewController = NSHostingController(rootView: PopoverView(store: store, launcher: launcher, height: height))
        launcher.onReturnToPopover = { [weak self] in
            guard let self, !self.popover.isShown else { return }
            self.togglePopover()
        }
        store.onChange = { [weak self] in self?.updateStatus() }
        updateStatus()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !popover.isShown { togglePopover() }
        return false
    }

    @objc private func togglePopover() {
        guard let button = item?.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else {
            store.popoverVisible = true
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func popoverDidClose(_ notification: Notification) { store.popoverVisible = false }

    private func updateStatus() {
        let running = store.sessions.filter(\.running)
        let count = running.reduce(0) { $0 + $1.activeCount }
        let attention = store.sessions.contains(where: \.attention)
        item.button?.title = attention ? " !" : count > 0 ? " \(count)" : ""
        let status = attention ? "Needs attention" : !running.isEmpty ? "\(count) agents working" : "Ready"
        item.button?.toolTip = "theFactory · \(status)"
        item.button?.setAccessibilityLabel("theFactory. \(status). Show agent progress.")
    }
}

#if !FACTORY_STATUS_CHECKS
@main
enum FactoryMenuBar {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--render-previews"), arguments.indices.contains(index + 1) {
            do { try PreviewData.render(to: URL(fileURLWithPath: arguments[index + 1], isDirectory: true)) }
            catch { fputs("Preview failed: \(error)\n", stderr); exit(1) }
            return
        }
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
