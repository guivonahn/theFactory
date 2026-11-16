import SwiftUI

enum LaunchPane: String, CaseIterable {
    case task = "Task", agents = "Agents", options = "Options"
}

struct LaunchView: View {
    @ObservedObject var launcher: SessionLauncher
    let knownSessionIDs: Set<String>
    var preview = false
    @State private var pane: LaunchPane
    @StateObject private var catalog: ModelCatalog

    private let roles = IdleFactoryView.sleepingCrew

    init(launcher: SessionLauncher, knownSessionIDs: Set<String>, preview: Bool = false, showSettings: Bool = false, initialPane: LaunchPane = .task, modelCatalog: ModelCatalog? = nil) {
        self.launcher = launcher; self.knownSessionIDs = knownSessionIDs; self.preview = preview
        _pane = State(initialValue: showSettings ? .agents : initialPane)
        _catalog = StateObject(wrappedValue: modelCatalog ?? ModelCatalog())
    }

    var body: some View {
        VStack(spacing: 0) {
            if let target = launcher.selectingModel {
                ModelListView(catalog: catalog, selection: modelBinding(target), inheritLabel: target == "all" ? "Use selected profile" : "Inherit shared model", refresh: { refreshModels(force: true) }, close: { launcher.selectingModel = nil })
                    .onAppear { refreshModels() }
            } else {
                Picker("Session configuration", selection: $pane) {
                    ForEach(LaunchPane.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().controlSize(.regular)
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 6)

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        switch pane {
                        case .task: taskContent
                        case .agents: agentContent
                        case .options: optionContent
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 16)
                }
                .id(pane)
                launchBar
            }
        }
    }

    private var taskContent: some View {
        Group {
            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Project")
                HStack(spacing: 8) {
                    Image(systemName: "folder").foregroundStyle(.secondary).accessibilityHidden(true)
                    TextField("Project directory", text: $launcher.directory)
                        .textFieldStyle(.roundedBorder).font(.system(size: 11))
                        .accessibilityLabel("Project directory")
                    Button("Choose…") { launcher.chooseDirectory() }
                        .controlSize(.small).help("Choose a project directory")
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Prompt")
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $launcher.prompt)
                        .font(.system(size: 12)).padding(6)
                        .accessibilityLabel("Prompt for the new session")
                    if launcher.prompt.isEmpty {
                        Text("What should the crew work on?")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                            .padding(.horizontal, 11).padding(.vertical, 10)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .frame(height: 140)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(nsColor: .separatorColor), lineWidth: 0.5))
            }

            settingsGroup {
                settingRow("Profile") {
                    Picker("Profile", selection: $launcher.settings.profile) {
                        Text("Saved configuration").tag("saved")
                        Text("Low effort").tag("low")
                        Text("Medium effort").tag("medium")
                        Text("High effort").tag("high")
                        Text("Free models").tag("free")
                        Text("Saved Custom").tag("custom")
                    }.labelsHidden().frame(width: 174, alignment: .trailing)
                }
                rowDivider
                settingRow("Execution") {
                    Picker("Execution", selection: $launcher.settings.execution) {
                        Text("Standard").tag("standard")
                        Text("Parallel workers").tag("parallel")
                        Text("Sequential").tag("sequential")
                    }.labelsHidden().frame(width: 174, alignment: .trailing)
                }
                if launcher.settings.execution == "parallel" {
                    rowDivider
                    settingRow("Workers") {
                        Stepper(value: $launcher.settings.workers, in: 1...16) {
                            Text("\(launcher.settings.workers)").monospacedDigit().frame(width: 24)
                        }.fixedSize().accessibilityLabel("Parallel workers")
                    }
                }
            }
        }
    }

    private var agentContent: some View {
        Group {
            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Model for all agents")
                modelSelector(target: "all", defaultLabel: "Use the selected profile")
                Text("Choose from this project’s available models.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Individual agents")
                settingsGroup {
                    agentModelRow(role: "orchestrator", name: "Orchestrator", color: .primary)
                    ForEach(roles) { role in
                        rowDivider
                        agentModelRow(role: role.role, name: role.role.capitalized, color: Color(agentHex: role.color))
                    }
                }
                Text("Individual choices override the profile and shared model.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }

    private var optionContent: some View {
        Group {
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Output")
                settingsGroup {
                    settingRow("Verbosity") {
                        Picker("Verbosity", selection: $launcher.settings.verbosity) {
                            Text("Keep current").tag("saved")
                            Text("Low").tag("low")
                            Text("Medium").tag("medium")
                            Text("High").tag("high")
                        }.labelsHidden().frame(width: 152, alignment: .trailing)
                    }
                    rowDivider
                    switchRow("Mute sounds", detail: "Keep this terminal session quiet.", value: $launcher.settings.muted)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Workflow")
                settingsGroup {
                    switchRow("Model fallback", detail: "Try another model when a route is unavailable.", value: $launcher.settings.autoFallback)
                    rowDivider
                    switchRow("Graphify", detail: "Use the project’s code knowledge graph.", value: $launcher.settings.graphify)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                fieldLabel("Permissions")
                settingsGroup {
                    switchRow("Approve tool requests", detail: "Explicit deny rules still apply.", value: $launcher.settings.auto)
                }
            }
        }
    }

    private var launchBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            if let error = launcher.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let notice = launcher.notice {
                Text(notice).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text("Opens Terminal").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    if !preview { launcher.launch(knownSessionIDs: knownSessionIDs) }
                } label: {
                    Text(launcher.awaitingSession ? "Starting…" : "Start in Terminal")
                        .frame(minWidth: 116)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(!launcher.canLaunch)
                .keyboardShortcut(.return, modifiers: .command)
                .help("Start a fresh session · Command-Return")
            }
        }
        .padding(.horizontal, 20).padding(.bottom, 14)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
    }

    private func settingsGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var rowDivider: some View { Divider().padding(.horizontal, 12) }

    private func settingRow<Content: View>(_ title: String, @ViewBuilder control: () -> Content) -> some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 12))
            Spacer(minLength: 6)
            control().font(.system(size: 11)).controlSize(.small)
        }.padding(.horizontal, 12).padding(.vertical, 9)
    }

    private func agentModelRow(role: String, name: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 5, height: 5).accessibilityHidden(true)
            Text(name).font(.system(size: 11)).frame(width: 78, alignment: .leading)
            modelSelector(target: role, defaultLabel: "Inherit")
        }.padding(.horizontal, 12).padding(.vertical, 7)
    }

    private func switchRow(_ title: String, detail: String, value: Binding<Bool>) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 12))
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: value).labelsHidden().toggleStyle(.switch).controlSize(.mini)
                .accessibilityLabel(title)
        }.padding(.horizontal, 12).padding(.vertical, 10)
    }

    private func modelBinding(_ target: String) -> Binding<String> {
        target == "all" ? $launcher.settings.model : Binding(get: { launcher.settings.agentModels[target] ?? "" }, set: { launcher.settings.agentModels[target] = $0 })
    }

    private func modelSelector(target: String, defaultLabel: String) -> some View {
        let value = modelBinding(target).wrappedValue
        return Button { launcher.selectingModel = target } label: {
            HStack(spacing: 6) {
                Text(value.isEmpty ? defaultLabel : value).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .medium))
            }.frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered).controlSize(.small).font(.system(size: 11))
        .help(value.isEmpty ? defaultLabel : value)
        .accessibilityLabel(target == "all" ? "Choose model for all agents" : "Choose \(target) model")
    }

    private func refreshModels(force: Bool = false) {
        if !preview { catalog.refresh(directory: launcher.expandedDirectory, force: force) }
    }
}
