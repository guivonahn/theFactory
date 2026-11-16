import SwiftUI

struct ModelListView: View {
    @ObservedObject var catalog: ModelCatalog
    @Binding var selection: String
    let inheritLabel: String
    let refresh: () -> Void
    let close: () -> Void
    @State private var query = ""
    @State private var highlighted: String?

    init(catalog: ModelCatalog, selection: Binding<String>, inheritLabel: String, refresh: @escaping () -> Void, close: @escaping () -> Void) {
        self.catalog = catalog; _selection = selection; self.inheritLabel = inheritLabel
        self.refresh = refresh; self.close = close
        _highlighted = State(initialValue: selection.wrappedValue)
    }

    private var filtered: [String] { ModelCatalog.filtered(catalog.models, query: query) }
    private var providers: [String] { Array(Set(filtered.map { String($0.split(separator: "/", maxSplits: 1)[0]) })).sorted(by: ModelCatalog.providerOrder) }
    private var savedOutsideCatalog: Bool { !selection.isEmpty && !catalog.models.contains(selection) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField("Search available models", text: Binding(get: { query }, set: { value in
                    query = value
                    highlighted = value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? selection : ModelCatalog.filtered(catalog.models, query: value).first
                }), prompt: Text("Search models or providers").foregroundColor(.secondary))
                .textFieldStyle(.roundedBorder).font(.system(size: 12))
                .accessibilityLabel("Search available models")
                Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).disabled(catalog.loading)
                    .help("Refresh available models").accessibilityLabel("Refresh available models")
            }.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 10)

            HStack {
                Text(catalog.loading ? "Loading models…" : "\(filtered.count) models")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                if catalog.loading { ProgressView().controlSize(.small) }
            }.padding(.horizontal, 20).padding(.bottom, 8)

            if let error = catalog.error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20).padding(.bottom, 8)
            }

            List(selection: $highlighted) {
                Text(inheritLabel).font(.system(size: 12)).tag("")
                if savedOutsideCatalog && (query.isEmpty || selection.localizedCaseInsensitiveContains(query)) {
                    Section("Current selection") { modelRow(selection) }
                }
                ForEach(providers, id: \.self) { provider in
                    Section(provider) {
                        ForEach(filtered.filter { $0.hasPrefix(provider + "/") }, id: \.self) { id in modelRow(id) }
                    }
                }
                if filtered.isEmpty && !catalog.loading {
                    Text(query.isEmpty ? "No models loaded. Try refreshing." : "No models match your search.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            .listStyle(.inset).scrollContentBackground(.hidden)
            .accessibilityLabel("Available models")

            VStack(alignment: .leading, spacing: 10) {
                Divider()
                Text(highlighted.flatMap { $0.isEmpty ? inheritLabel : $0 } ?? "Choose a model from the list")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .help(highlighted ?? "")
                HStack {
                    Spacer()
                    Button(highlighted == "" ? "Use default" : "Use model") {
                        guard let highlighted else { return }
                        selection = highlighted
                        close()
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(highlighted == nil)
                    .keyboardShortcut(.return, modifiers: [])
                }
            }.padding(.horizontal, 20).padding(.bottom, 14)
        }
        .onReceive(catalog.$models) { models in
            if highlighted == nil && !query.isEmpty { highlighted = ModelCatalog.filtered(models, query: query).first }
        }
    }

    private func modelRow(_ id: String) -> some View {
        HStack(spacing: 8) {
            Text(id.split(separator: "/", maxSplits: 1).dropFirst().joined(separator: "/"))
                .font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if id == selection {
                Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 23, alignment: .leading)
        .tag(id).help(id).accessibilityLabel(id)
    }
}
