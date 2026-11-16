import AppKit
import ServiceManagement
import SwiftUI

struct PopoverView: View {
    @ObservedObject var store: SessionStore
    @ObservedObject var launcher: SessionLauncher
    var height: CGFloat = 610
    var preview = false
    var previewSettings = false
    var previewComposing = false
    var previewLaunchPane: LaunchPane = .task
    var previewModelCatalog: ModelCatalog? = nil
    @State private var composing = false
    @State private var loginEnabled = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?
    @Environment(\.colorScheme) private var scheme

    private var session: FactorySnapshot? {
        if let selected = store.selected, selected.state != "idle" || selected.running || selected.attention { return selected }
        return store.sessions.first(where: { $0.running || $0.attention }) ?? store.selected
    }
    private var showingConfiguration: Bool { composing || previewComposing }
    private var showingIdle: Bool {
        !showingConfiguration && (session == nil || (session?.state == "idle" && session?.running == false && session?.attention == false))
    }
    private var attentionColor: Color { scheme == .light ? Color(agentHex: "#8A4B00") : .orange }
    private var workingColor: Color { scheme == .light ? Color(agentHex: "#1B733A") : .green }
    private var statusColor: Color {
        guard let session else { return .secondary }
        return session.attention ? attentionColor : session.running || session.state == "done" ? workingColor : .secondary
    }

    var body: some View {
        VStack(spacing: 0) {
            if showingIdle {
                IdleFactoryView(visible: store.popoverVisible) { composing = true }
            } else {
                header.padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
                Divider()
                if showingConfiguration {
                    LaunchView(launcher: launcher, knownSessionIDs: Set(store.sessions.map(\.id)), preview: preview, showSettings: previewSettings, initialPane: previewLaunchPane, modelCatalog: previewModelCatalog)
                } else if let session {
                    sessionContent(session)
                }
                if let error = store.readError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 20).padding(.bottom, 10)
                }
                Divider()
                footer.padding(.horizontal, 16).padding(.vertical, 10)
            }
        }
        .frame(width: 380, height: height)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.55))
        .onReceive(store.$sessions) { sessions in
            if let connected = launcher.connectedSession(in: sessions) {
                store.selectedID = connected.id
                composing = false
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        if showingConfiguration {
            HStack(spacing: 10) {
                Button {
                    if launcher.selectingModel != nil { launcher.selectingModel = nil }
                    else { composing = false }
                } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless).help(launcher.selectingModel == nil ? "Back to the factory" : "Back to agent settings")
                    .accessibilityLabel(launcher.selectingModel == nil ? "Back to the factory" : "Back to agent settings")
                Text(launcher.selectingModel.map { $0 == "all" ? "Model for all agents" : "\($0.capitalized) model" } ?? "New session")
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                Image(nsImage: FactoryIcon.image).opacity(0.5).accessibilityHidden(true)
            }
        } else {
            HStack(alignment: .center, spacing: 9) {
                Image(nsImage: FactoryIcon.image).imageScale(.large)
                    .accessibilityHidden(true)
                Text("theFactory").font(.system(size: 16, weight: .semibold))
                Spacer()
                if session != nil {
                    Button("New") { composing = true }
                        .font(.system(size: 11)).controlSize(.small)
                        .help("Start a new session")
                }
                if store.sessions.count > 1 {
                    Menu {
                        ForEach(store.sessions) { item in
                            Button {
                                store.selectedID = item.id
                            } label: {
                                Text("\(item.id == store.selected?.id ? "✓ " : "")\(item.project) · \(item.label) · \(item.title.prefix(50))")
                            }
                        }
                    } label: {
                        Text("\(store.sessions.count) sessions").font(.system(size: 11))
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                    .help("Choose a running theFactory terminal")
                } else {
                    HStack(spacing: 5) {
                        Circle().fill(statusColor).frame(width: 5, height: 5)
                        Text(session?.label ?? "Idle").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func sessionContent(_ session: FactorySnapshot) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                Image(systemName: "folder").accessibilityHidden(true)
                Text(session.project).lineLimit(1).truncationMode(.middle)
                Spacer()
                if session.mode == "demo" { Text("Demo").foregroundStyle(attentionColor) }
                Text(elapsed(session.elapsedSeconds)).monospacedDigit()
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
            .padding(.bottom, 8).help(session.directory)

            Text(session.title.isEmpty ? "Your next idea starts here." : session.title)
                .font(.system(size: 15, weight: .medium)).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(session.title).padding(.bottom, 12)

            HStack(alignment: .firstTextBaseline) {
                Text(session.label).font(.system(size: 11, weight: .medium)).foregroundStyle(statusColor)
                Spacer()
                Text(session.progress.label).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
            }.padding(.bottom, 6)
            if session.progress.indeterminate {
                ProgressView().progressViewStyle(.linear).controlSize(.small)
                    .accessibilityLabel("\(session.progress.label). No plan percentage available.")
            } else {
                ProgressView(value: min(1, max(0, session.progress.fraction ?? 0)))
                    .tint(session.attention ? .orange : .accentColor).controlSize(.small)
                    .accessibilityLabel("Plan progress").accessibilityValue(session.progress.label)
            }

            FactoryScene(agents: session.agents, visible: store.popoverVisible, state: session.state)
                .padding(.horizontal, -4).padding(.top, 2)

            HStack {
                Text("The crew").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(session.activeCount) working").font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(.bottom, 6)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(session.agents) { agent in
                        agentRow(agent)
                        if agent.id != session.agents.last?.id { Divider().padding(.leading, 28) }
                    }
                }
            }.frame(maxHeight: .infinity)

            if session.attention {
                Label("Check your terminal for details.", systemImage: "exclamationmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 10)
            }
        }
        .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
    }

    private func agentRow(_ agent: AgentSnapshot) -> some View {
        HStack(spacing: 10) {
            Image(systemName: roleSymbol(agent.role))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(agent.role == "orchestrator" ? Color.primary : Color(agentHex: agent.color))
                .frame(width: 18, height: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(agent.name).font(.system(size: 12, weight: .medium))
                    Text(agent.role).font(.system(size: 10)).foregroundStyle(.secondary)
                }.lineLimit(1)
                if !agent.detail.isEmpty && agent.state != "idle" {
                    Text(agent.detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 4) {
                if agent.state == "completed" { Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)) }
                else if agent.needsAttention { Image(systemName: "exclamationmark.circle").font(.system(size: 10)) }
                else if agent.active { Circle().frame(width: 4, height: 4) }
                Text(agent.label).font(.system(size: 10))
            }
            .foregroundStyle(agent.needsAttention ? attentionColor : agent.active ? .primary : .secondary)
            .fixedSize()
        }
        .frame(minHeight: 37)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .help(agent.detail.isEmpty ? "\(agent.role): \(agent.label)" : agent.detail)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(agent.name), \(agent.role), \(agent.label). \(agent.detail)")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if preview {
                    Text("Preview · illustrative session").font(.system(size: 10)).foregroundStyle(.secondary)
                } else {
                    Toggle("Launch at login", isOn: Binding(get: { loginEnabled }, set: { enabled in
                            do {
                                if enabled { try SMAppService.mainApp.register() }
                                else { try SMAppService.mainApp.unregister() }
                                loginError = SMAppService.mainApp.status == .requiresApproval
                                    ? "Allow theFactory in System Settings → Login Items." : nil
                            } catch {
                                loginError = "Couldn’t change login settings. Try again from Applications."
                            }
                            let status = SMAppService.mainApp.status
                            loginEnabled = status == .enabled || status == .requiresApproval
                        }))
                        .toggleStyle(.checkbox).font(.system(size: 11))
                }
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.borderless).font(.system(size: 11))
                    .help("Quit the menu bar companion; terminal sessions keep running")
                    .keyboardShortcut("q")
            }
            if let loginError {
                Text(loginError).font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func elapsed(_ seconds: Int) -> String {
        let seconds = max(0, seconds)
        if seconds >= 3600 { return "\(seconds / 3600)h \(seconds % 3600 / 60)m" }
        return "\(seconds / 60)m \(seconds % 60)s"
    }

    private func roleSymbol(_ role: String) -> String {
        switch role {
        case "orchestrator": return "point.3.connected.trianglepath.dotted"
        case "explorer": return "safari"
        case "architect": return "square.3.layers.3d"
        case "developer": return "chevron.left.forwardslash.chevron.right"
        case "reviewer": return "eyeglasses"
        case "security": return "lock.shield"
        case "tester": return "checkmark.seal"
        default: return "person"
        }
    }
}
