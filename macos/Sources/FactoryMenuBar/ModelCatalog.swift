import AppKit
import Combine
import Foundation

struct ModelCatalogResponse: Decodable {
    let version: Int
    let models: [String]
    let error: String?
}

enum ModelCatalogReader {
    static func read(node: String, cli: String, directory: URL) throws -> ModelCatalogResponse {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [cli, "--model-catalog"]
        process.currentDirectoryURL = directory
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        process.environment = env
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 20, execute: timeout)
        defer { timeout.cancel(); if process.isRunning { process.terminate() } }
        var data = Data()
        while let part = try output.fileHandleForReading.read(upToCount: 16_384), !part.isEmpty {
            data.append(part)
            guard data.count <= 4 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
        let result = try JSONDecoder().decode(ModelCatalogResponse.self, from: data)
        guard result.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
        return result
    }
}

final class ModelCatalog: ObservableObject {
    @Published var models: [String]
    @Published var loading = false
    @Published var error: String?
    private var scope: String?
    private var refreshedAt: Date?
    private var requestedDirectory: String?

    init(models: [String] = []) { self.models = models }

    func refresh(directory: String, force: Bool = false) {
        requestedDirectory = directory
        guard !loading else { return }
        if !force, scope == directory, let refreshedAt, Date().timeIntervalSince(refreshedAt) < 60 { return }
        guard let node = Bundle.main.object(forInfoDictionaryKey: "FactoryNodePath") as? String,
              let cli = Bundle.main.object(forInfoDictionaryKey: "FactoryCLIPath") as? String else {
            error = "Rebuild the companion to connect the model catalog."; return
        }
        if scope != directory { models = [] }
        scope = directory; loading = true; error = nil
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory)
        let cwd = exists && isDirectory.boolValue ? URL(fileURLWithPath: directory, isDirectory: true) : FileManager.default.homeDirectoryForCurrentUser
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Result { try ModelCatalogReader.read(node: node, cli: cli, directory: cwd) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading = false
                if let requested = self.requestedDirectory, requested != directory {
                    self.refresh(directory: requested, force: true)
                    return
                }
                switch result {
                case .success(let catalog):
                    self.models = Array(Set(catalog.models.filter(Self.validModel))).sorted()
                    self.error = catalog.error
                    self.refreshedAt = Date()
                case .failure:
                    self.error = "Couldn’t refresh models. Check the CLI setup and try again."
                }
            }
        }
    }

    static func validModel(_ id: String) -> Bool {
        id.range(of: #"^[^\s/#]+/[^\s#]+(?:#[^\s#]+)?$"#, options: .regularExpression) != nil
    }

    static func filtered(_ models: [String], query: String) -> [String] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? models : models.filter { $0.localizedCaseInsensitiveContains(query) }
    }

    static func providerOrder(_ lhs: String, _ rhs: String) -> Bool {
        let left = lhs.hasPrefix("coarena-"), right = rhs.hasPrefix("coarena-")
        return left != right ? left : lhs.localizedStandardCompare(rhs) == .orderedAscending
    }
}
