import AppKit
import Combine
import Foundation

struct LaunchSettings: Codable {
    var profile = "saved"
    var model = ""
    var verbosity = "saved"
    var execution = "standard"
    var workers = 3
    var auto = false
    var autoFallback = true
    var graphify = true
    var muted = false
    var agentModels: [String: String] = [:]
}

struct LaunchRequest: Encodable {
    let id = UUID().uuidString
    let version = 1
    let directory: String
    let prompt: String
    let profile: String
    let model: String
    let verbosity: String
    let execution: String
    let workers: Int
    let auto: Bool
    let autoFallback: Bool
    let graphify: Bool
    let muted: Bool
    let agentModels: [String: String]

    init(directory: String, prompt: String, settings: LaunchSettings) {
        self.directory = directory; self.prompt = prompt
        profile = settings.profile; model = settings.model.trimmingCharacters(in: .whitespacesAndNewlines)
        verbosity = settings.verbosity; execution = settings.execution; workers = settings.workers
        auto = settings.auto; autoFallback = settings.autoFallback; graphify = settings.graphify; muted = settings.muted
        agentModels = settings.agentModels.mapValues { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.value.isEmpty }
    }
}

enum TerminalLaunch {
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    static func script(node: String, cli: String, request: String, directory: String, script: String) -> String {
        // All user text lives in JSON; only individually quoted paths enter the shell.
        """
        #!/bin/bash
        export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH
        request=\(quote(request))
        launch_script=\(quote(script))
        trap 'rm -f -- "$request" "$launch_script"' EXIT
        cd -- \(quote(directory)) || exit 1
        \(quote(node)) \(quote(cli)) --launch-request "$request"
        result=$?
        if [ "$result" -ne 0 ]; then
            printf '\\nSession could not start. Review the message above.\\n'
        fi
        exit "$result"
        """
    }

    static func prepare(request: LaunchRequest, node: String, cli: String, in directory: URL) throws -> URL {
        let manager = FileManager.default
        guard manager.isExecutableFile(atPath: node), manager.fileExists(atPath: cli) else {
            throw NSError(domain: "theFactory", code: 1, userInfo: [NSLocalizedDescriptionKey: "The CLI moved or Node is unavailable. Rebuild the companion from your theFactory checkout."])
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let id = UUID().uuidString
        let json = directory.appendingPathComponent("\(id).json")
        let command = directory.appendingPathComponent("\(id).command")
        do {
            try manager.createFileSecurely(at: json, data: JSONEncoder().encode(request), mode: 0o600)
            let source = script(node: node, cli: cli, request: json.path, directory: request.directory, script: command.path)
            try manager.createFileSecurely(at: command, data: Data(source.utf8), mode: 0o700)
            return command
        } catch {
            try? manager.removeItem(at: json); try? manager.removeItem(at: command)
            throw error
        }
    }
}

private extension FileManager {
    func createFileSecurely(at url: URL, data: Data, mode: Int) throws {
        guard createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: mode]) else { throw CocoaError(.fileWriteUnknown) }
    }
}

final class SessionLauncher: ObservableObject {
    @Published var directory: String
    @Published var prompt = ""
    @Published var settings: LaunchSettings
    @Published var error: String?
    @Published var awaitingSession = false
    @Published var notice: String?
    @Published var selectingModel: String?
    var onReturnToPopover: (() -> Void)?
    var knownSessionIDs: Set<String> = []
    private var launchToken: UUID?
    private var pendingLaunchID: String?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        directory = defaults.string(forKey: "launchDirectory") ?? FileManager.default.homeDirectoryForCurrentUser.path
        if let data = defaults.data(forKey: "launchSettings"), let saved = try? JSONDecoder().decode(LaunchSettings.self, from: data) { settings = saved }
        else { settings = LaunchSettings() }
    }

    var expandedDirectory: String { (directory as NSString).expandingTildeInPath }
    var canLaunch: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !directory.isEmpty && !awaitingSession }

    func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Choose project"
        panel.directoryURL = URL(fileURLWithPath: expandedDirectory, isDirectory: true)
        panel.begin { [weak self] result in
            guard let self else { return }
            if result == .OK, let url = panel.url { self.directory = url.path; self.defaults.set(url.path, forKey: "launchDirectory") }
            self.onReturnToPopover?()
        }
    }

    func launch(knownSessionIDs: Set<String>) {
        guard canLaunch else { return }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: expandedDirectory, isDirectory: &isDirectory), isDirectory.boolValue else {
            error = "Choose an existing project directory."; return
        }
        guard prompt.utf8.count <= 131_072, !prompt.contains("\0") else { error = "Keep the prompt under 128 KB and remove null characters."; return }
        let models = [settings.model] + Array(settings.agentModels.values)
        guard models.allSatisfy({ $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[^\s/#]+/[^\s#]+(?:#[^\s#]+)?$"#, options: .regularExpression) != nil }) else {
            error = "Use provider/model or provider/model#variant for model choices."; return
        }
        guard let node = Bundle.main.object(forInfoDictionaryKey: "FactoryNodePath") as? String,
              let cli = Bundle.main.object(forInfoDictionaryKey: "FactoryCLIPath") as? String,
              let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            error = "Rebuild the companion to connect its CLI and Terminal launcher."; return
        }
        let request = LaunchRequest(directory: expandedDirectory, prompt: prompt, settings: settings)
        do {
            let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/theFactory/launches", isDirectory: true)
            let command = try TerminalLaunch.prepare(request: request, node: node, cli: cli, in: directory)
            defaults.set(expandedDirectory, forKey: "launchDirectory")
            defaults.set(try JSONEncoder().encode(settings), forKey: "launchSettings")
            self.knownSessionIDs = knownSessionIDs
            pendingLaunchID = request.id
            error = nil; notice = "Opening Terminal…"; awaitingSession = true
            let token = UUID(); launchToken = token
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.open([command], withApplicationAt: terminal, configuration: configuration) { [weak self] _, failure in
                DispatchQueue.main.async {
                    guard let self, self.launchToken == token else { return }
                    if let failure {
                        self.awaitingSession = false; self.notice = nil; self.error = failure.localizedDescription
                        try? FileManager.default.removeItem(at: command)
                        try? FileManager.default.removeItem(at: command.deletingPathExtension().appendingPathExtension("json"))
                        self.onReturnToPopover?()
                    } else { self.notice = "Terminal opened. Connecting to your crew…" }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                guard let self, self.launchToken == token, self.awaitingSession else { return }
                self.awaitingSession = false; self.notice = nil
                self.error = "Terminal opened, but no session connected. Check the message in Terminal."
            }
        } catch { self.error = error.localizedDescription; notice = nil; awaitingSession = false }
    }

    func connectedSession(in sessions: [FactorySnapshot]) -> FactorySnapshot? {
        guard awaitingSession, let session = sessions.first(where: { !knownSessionIDs.contains($0.id) && $0.launchID == pendingLaunchID && $0.mode == "task" }) else { return nil }
        awaitingSession = false; notice = nil; error = nil; launchToken = nil
        pendingLaunchID = nil
        prompt = ""
        return session
    }
}
