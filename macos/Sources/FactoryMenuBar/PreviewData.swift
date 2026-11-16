import AppKit
import SwiftUI

/// Explicitly requested offline previews only; never substituted for live data.
enum PreviewData {
    static let roles = ["orchestrator", "explorer", "architect", "developer", "reviewer", "security", "tester"]
    static let names = ["orca", "xp", "mosby", "denver", "four eyes", "firewall", "qually"]
    static let colors = ["#FFFFFF", "#64D2FF", "#BF5AF2", "#30D158", "#FFD60A", "#FF453A", "#0A84FF"]
    static var restingAgents: [AgentSnapshot] {
        roles.indices.map { AgentSnapshot(id: roles[$0], role: roles[$0], name: names[$0], color: colors[$0], state: "idle", detail: "", sessionID: nil) }
    }
    static func session(state: String = "running") -> FactorySnapshot {
        let states = state == "done" ? Array(repeating: "completed", count: 7)
            : state == "blocked" ? ["blocked", "completed", "completed", "completed", "blocked", "idle", "failed"]
            : ["thinking", "completed", "completed", "working", "thinking", "idle", "queued"]
        let details = ["Coordinating the crew", "Mapped the existing session system", "Designed the native popover", "Connecting live agent progress", "Checking progress and session states", "", "Waiting for the implementation"]
        let agents = roles.indices.map { AgentSnapshot(id: roles[$0], role: roles[$0], name: names[$0], color: colors[$0], state: states[$0], detail: details[$0], sessionID: nil) }
        return FactorySnapshot(schemaVersion: 1, id: "preview", pid: getpid(), updatedAt: Date().timeIntervalSince1970 * 1000,
            mode: "task", directory: "/Projects/theFactory", sessionID: "preview", title: "Build a little home for the crew in the menu bar",
            state: state, phase: "working", activity: "Connecting live progress", elapsedSeconds: 162,
            progress: ProgressSnapshot(fraction: state == "done" ? 1 : 0.4, label: state == "done" ? "100% complete" : state == "blocked" ? "40% incomplete" : "40% 2/5 steps", indeterminate: false),
            agents: agents, tasks: [])
    }

    static func render(to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for appearance in ["light", "dark"] {
            for state in ["running", "blocked", "done", "idle", "configure", "parallel", "settings", "options", "empty", "launch-error", "launching", "configure-compact", "settings-compact", "options-compact", "model-all", "model-agent", "model-current", "model-late", "model-loading", "model-error", "model-empty", "model-agent-compact"] {
                let page = state.replacingOccurrences(of: "-compact", with: "")
                let height: CGFloat = state.hasSuffix("-compact") ? 420 : 610
                let store = SessionStore()
                store.sessions = ["running", "blocked", "done"].contains(page) ? [session(state: page)] : []
                let defaults = UserDefaults(suiteName: "dev.thefactory.preview")!
                let launcher = SessionLauncher(defaults: defaults)
                launcher.directory = "/Projects/theFactory"
                launcher.prompt = state == "empty" ? "" : "Build a native menu bar home for the crew."
                if state == "parallel" { launcher.settings.execution = "parallel" }
                if state == "launch-error" { launcher.error = "Choose an existing project directory." }
                if state == "launching" { launcher.awaitingSession = true; launcher.notice = "Terminal opened. Connecting to your crew…" }
                let catalog = ModelCatalog(models: [
                    "coarena-1/claude-opus-5-5", "coarena-1/claude-fable-5-2",
                    "coarena-2/claude-opus-5-5", "coarena-2/claude-fable-5-2",
                    "opencode-go/glm-5.3", "opencode-go/deepseek-v4-pro", "opencode-go/qwen3.8-max",
                    "opencode/beam-free", "opencode/iceman-free"
                ])
                if page.hasPrefix("model-") {
                    launcher.selectingModel = page == "model-all" ? "all" : "developer"
                    if page == "model-current" { launcher.settings.agentModels["developer"] = "opencode-go/qwen3.8-max#max" }
                    if page == "model-late" { launcher.settings.agentModels["developer"] = "opencode-go/qwen3.8-max" }
                    if page == "model-loading" { catalog.models = []; catalog.loading = true }
                    if page == "model-error" { catalog.models = Array(catalog.models.prefix(4)); catalog.error = "Couldn’t refresh the OpenCode catalog. Only configured models are shown. Try refreshing." }
                    if page == "model-empty" { catalog.models = [] }
                }
                let root = PopoverView(store: store, launcher: launcher, height: height, preview: true, previewSettings: page == "settings", previewComposing: !["idle", "running", "blocked", "done"].contains(page), previewLaunchPane: page == "options" ? .options : page.hasPrefix("model-") ? .agents : .task, previewModelCatalog: catalog).environment(\.colorScheme, appearance == "dark" ? .dark : .light)
                let host = NSHostingView(rootView: root)
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
                window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
                window.contentView = host
                host.frame = window.contentView!.bounds
                host.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { throw CocoaError(.fileWriteUnknown) }
                host.cacheDisplay(in: host.bounds, to: bitmap)
                guard let data = bitmap.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
                try data.write(to: directory.appendingPathComponent("\(state)-\(appearance).png"))
                window.orderOut(nil)
            }
        }
    }
}
