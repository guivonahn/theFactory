import AppKit
import Foundation

struct CheckFailure: Error { let message: String }

/// Runs with Command Line Tools alone: no XCTest/full Xcode dependency.
@main
enum SessionReaderChecks {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw CheckFailure(message: message) }
    }

    static func main() throws {
        let session = PreviewData.session()
        let now = Date(timeIntervalSince1970: session.updatedAt / 1000)
        try require(session.isLive(now: now, isAlive: { _ in true }), "Fresh live heartbeat rejected")
        try require(!session.isLive(now: now, isAlive: { _ in false }), "Dead publisher accepted")
        try require(!session.isLive(now: now.addingTimeInterval(16), isAlive: { _ in true }), "Stale heartbeat accepted")
        try require(!session.isLive(now: now.addingTimeInterval(-10), isAlive: { _ in true }), "Future heartbeat accepted")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let data = try JSONEncoder().encode(session)
        try data.write(to: directory.appendingPathComponent("valid.json"))
        try Data("{bad".utf8).write(to: directory.appendingPathComponent("bad.json"))
        try Data("partial".utf8).write(to: directory.appendingPathComponent("123.json.tmp"))
        let result = SessionReader.read(from: directory, isAlive: { _ in true })
        try require(result.sessions.count == 1, "Malformed file hid valid session")
        try require(result.error != nil, "Malformed file did not report a recoverable read error")
        try require(SessionReader.read(from: directory, isAlive: { _ in false }).sessions.isEmpty, "Reader accepted dead publisher")
        try require(SessionReader.read(from: directory, now: now.addingTimeInterval(30), isAlive: { _ in true }).sessions.isEmpty, "Reader accepted stale publisher")
        var futureSchema = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        futureSchema["schemaVersion"] = 2
        let unsupported = try JSONDecoder().decode(FactorySnapshot.self, from: JSONSerialization.data(withJSONObject: futureSchema))
        try require(!unsupported.isLive(now: now, isAlive: { _ in true }), "Unknown schema accepted")

        let missing = SessionReader.read(from: directory.appendingPathComponent("absent"))
        try require(missing.sessions.isEmpty && missing.error == nil, "Missing directory did not produce idle state")
        let blocked = PreviewData.session(state: "blocked")
        try require(blocked.attention && !blocked.running && blocked.progress.fraction == 0.4, "Blocked session implies running or complete")
        try require(FactoryScene.sceneCaption(agents: blocked.agents, state: blocked.state) == "The crew needs a hand.", "Blocked factory scene falsely claims readiness")
        let orca = session.agents[0]
        let onlyOrcaWorking = PreviewData.restingAgents.filter { $0.role != "orchestrator" } + [orca]
        try require(FactoryScene.displayedAgents(onlyOrcaWorking).first?.role == "orchestrator", "Active orchestrator has no visible worker")
        let lateDeveloper = AgentSnapshot(id: "late-developer", role: "developer", name: "denver", color: "#30D158", state: "working", detail: "", sessionID: nil)
        let crowdedCrew = PreviewData.restingAgents + [lateDeveloper]
        try require(FactoryScene.displayedAgents(crowdedCrew).first?.id == "late-developer", "Active worker after the first six was hidden")
        try require(FactoryScene.displayedAgents(crowdedCrew).count == 6, "Scene exceeded its six-character limit")
        print("Native status checks passed: heartbeat, liveness, schema, malformed files, missing directory, blocked progress.")

        // Execute the actual generated .command with a harmless stand-in for Node.
        // Verify quoting, cwd, literal prompt transport and cleanup without a provider.
        let project = directory.appendingPathComponent("project's $(literal)")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let fakeNode = directory.appendingPathComponent("node's test runtime")
        let fakeCLI = directory.appendingPathComponent("cli's entry.js")
        let received = directory.appendingPathComponent("received.json")
        let cwd = directory.appendingPathComponent("cwd.txt")
        let source = "#!/bin/sh\n/bin/cp -- \"$3\" \(TerminalLaunch.quote(received.path))\n/bin/pwd > \(TerminalLaunch.quote(cwd.path))\n"
        try Data(source.utf8).write(to: fakeNode)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fakeNode.path)
        try Data("fixture".utf8).write(to: fakeCLI)
        let prompt = "/path\n  Unicode 工場 🏭; $(touch NEVER) `echo nope` 'quoted'"
        let launchRequest = LaunchRequest(directory: project.path, prompt: prompt, settings: LaunchSettings())
        let command = try TerminalLaunch.prepare(request: launchRequest, node: fakeNode.path, cli: fakeCLI.path, in: directory.appendingPathComponent("launches"))
        let requestURL = command.deletingPathExtension().appendingPathExtension("json")
        let attributes = try FileManager.default.attributesOfItem(atPath: requestURL.path)
        try require((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Launch request is not private")
        let commandSource = try String(contentsOf: command, encoding: .utf8)
        try require(!commandSource.contains(prompt), "Prompt leaked into shell source")
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/bash"); shell.arguments = [command.path]
        try shell.run(); shell.waitUntilExit()
        try require(shell.terminationStatus == 0, "Generated launcher script failed")
        let transported = try JSONSerialization.jsonObject(with: Data(contentsOf: received)) as! [String: Any]
        try require(transported["prompt"] as? String == prompt, "Prompt was interpreted or altered by the shell")
        let actualCwd = try String(contentsOf: cwd, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try require(URL(fileURLWithPath: actualCwd).resolvingSymlinksInPath().path == project.resolvingSymlinksInPath().path, "Terminal launcher used the wrong directory")
        try require(!FileManager.default.fileExists(atPath: command.path) && !FileManager.default.fileExists(atPath: requestURL.path), "Launch files were not cleaned up")
        print("Native launch checks passed: quoted paths, literal multiline prompt, working directory, private request, cleanup.")

        let catalogFile = directory.appendingPathComponent("catalog.json")
        let catalogModels = ["opencode/test", "coarena-1/claude-test", "opencode-go/test#high"]
        let catalogData = try JSONSerialization.data(withJSONObject: ["version": 1, "models": catalogModels])
        try catalogData.write(to: catalogFile)
        let catalogScript = directory.appendingPathComponent("catalog.sh")
        try Data("#!/bin/sh\n[ \"$1\" = \"--model-catalog\" ] || exit 1\n/bin/cat \(TerminalLaunch.quote(catalogFile.path))\n".utf8).write(to: catalogScript)
        let decodedCatalog = try ModelCatalogReader.read(node: "/bin/sh", cli: catalogScript.path, directory: project)
        try require(decodedCatalog.models == catalogModels, "Native bridge lost models or variants")
        try require(ModelCatalog.filtered(catalogModels, query: "OPENCODE-GO") == [catalogModels[2]], "Model search is not case-insensitive")
        try require(ModelCatalog.providerOrder("coarena-1", "anthropic"), "Configured model aliases are buried in the list")
        try require(!ModelCatalog.validModel("not a model"), "Malformed model accepted")
        print("Native catalog checks passed: CLI decoding, full identifiers, case-insensitive search, configured-provider order.")

        if CommandLine.arguments.count > 4, CommandLine.arguments[1] == "--catalog" {
            let catalog = try ModelCatalogReader.read(node: CommandLine.arguments[2], cli: CommandLine.arguments[3], directory: URL(fileURLWithPath: CommandLine.arguments[4]))
            try require(!catalog.models.isEmpty && catalog.error == nil, "Live CLI catalog failed")
            print("Native live CLI catalog decoded: \(catalog.models.count) models.")
        } else if CommandLine.arguments.count > 1 {
            let live = SessionReader.read(from: URL(fileURLWithPath: CommandLine.arguments[1]))
            try require(!live.sessions.isEmpty, "No live CLI snapshot decoded")
            for item in live.sessions {
                print("Decoded CLI snapshot: mode=\(item.mode), agents=\(item.agents.count), working=\(item.activeCount), label=\(item.label)")
            }
        }
    }
}
