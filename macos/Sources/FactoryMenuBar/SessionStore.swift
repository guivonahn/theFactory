import AppKit
import Combine
import Foundation

struct AgentSnapshot: Codable, Identifiable {
    let id: String
    let role: String
    let name: String
    let color: String
    let state: String
    let detail: String
    let sessionID: String?
    var active: Bool { state == "working" || state == "thinking" }
    var needsAttention: Bool { state == "failed" || state == "blocked" }
    var label: String {
        switch state {
        case "working": return "Working"
        case "thinking": return "Thinking"
        case "completed": return "Done"
        case "failed": return "Failed"
        case "blocked": return "Blocked"
        case "cancelled": return "Cancelled"
        case "queued": return "Queued"
        default: return "Resting"
        }
    }
}

struct TaskSnapshot: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
}

struct ProgressSnapshot: Codable {
    let fraction: Double?
    let label: String
    let indeterminate: Bool
}

struct FactorySnapshot: Codable, Identifiable {
    var launchID: String? = nil
    let schemaVersion: Int
    let id: String
    let pid: Int32
    let updatedAt: Double
    let mode: String
    let directory: String
    let sessionID: String?
    let title: String
    let state: String
    let phase: String
    let activity: String
    let elapsedSeconds: Int
    let progress: ProgressSnapshot
    let agents: [AgentSnapshot]
    let tasks: [TaskSnapshot]

    var activeCount: Int { agents.filter(\.active).count }
    var attention: Bool { state == "error" || state == "blocked" || agents.contains(where: \.needsAttention) }
    var running: Bool { state == "running" || (mode != "task" && activeCount > 0) }
    var project: String { URL(fileURLWithPath: directory).lastPathComponent }
    var label: String {
        if mode == "demo" { return "Demo" }
        if attention { return "Needs attention" }
        if running { return phase == "planning" ? "Planning" : phase == "recap" ? "Writing overview" : "Working" }
        switch state {
        case "done": return "Complete"
        case "aborted": return "Cancelled"
        default: return "Ready"
        }
    }

    func isLive(now: Date = Date(), isAlive: (Int32) -> Bool = { Darwin.kill($0, 0) == 0 || errno == EPERM }) -> Bool {
        let age = now.timeIntervalSince1970 * 1000 - updatedAt
        return schemaVersion == 1 && pid > 0 && age >= -5000 && age < 15_000 && isAlive(pid)
    }
}

struct SessionReadResult {
    var sessions: [FactorySnapshot] = []
    var error: String?
}

enum SessionReader {
    static var directory: URL {
        if let override = ProcessInfo.processInfo.environment["FACTORY_MENUBAR_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/theFactory/menu-bar", isDirectory: true)
    }

    static func read(from directory: URL = directory, now: Date = Date(), isAlive: (Int32) -> Bool = { Darwin.kill($0, 0) == 0 || errno == EPERM }) -> SessionReadResult {
        do {
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            var result = SessionReadResult()
            for file in files.filter({ $0.pathExtension == "json" }).prefix(200) {
                do {
                    let attributes = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                    guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
                          (attributes.fileSize ?? Int.max) <= 262_144 else { continue }
                    let session = try JSONDecoder().decode(FactorySnapshot.self, from: Data(contentsOf: file))
                    guard session.isLive(now: now, isAlive: isAlive) else { continue }
                    result.sessions.append(session)
                } catch {
                    result.error = "A session status could not be read. Retrying automatically."
                }
            }
            result.sessions.sort {
                if $0.running != $1.running { return $0.running }
                return $0.id.localizedStandardCompare($1.id) == .orderedAscending
            }
            return result
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            return SessionReadResult()
        } catch {
            return SessionReadResult(error: "Session status is unavailable. Check access to theFactory’s local status folder.")
        }
    }
}

final class SessionStore: ObservableObject {
    @Published var sessions: [FactorySnapshot] = []
    @Published var selectedID: String?
    @Published var readError: String?
    @Published var popoverVisible = false
    var onChange: (() -> Void)?
    private let queue = DispatchQueue(label: "theFactory.session-reader", qos: .utility)
    private var timer: DispatchSourceTimer?
    var selected: FactorySnapshot? { sessions.first(where: { $0.id == selectedID }) ?? sessions.first }

    init() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1, leeway: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            let result = SessionReader.read()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.sessions = result.sessions
                self.readError = result.error
                if !self.sessions.contains(where: { $0.id == self.selectedID }) { self.selectedID = self.sessions.first?.id }
                self.onChange?()
            }
        }
        self.timer = timer
        timer.resume()
    }

    deinit { timer?.cancel() }
}
