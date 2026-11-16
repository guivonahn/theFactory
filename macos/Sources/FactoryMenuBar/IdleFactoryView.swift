import SwiftUI

struct IdleFactoryView: View {
    let visible: Bool
    let startWork: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text("theFactory").font(.system(size: 28, weight: .semibold))
            Text("Idle").font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary).padding(.top, 8)
            FactoryScene(agents: Self.sleepingCrew, visible: visible, snoozing: true)
                .frame(width: 270)
                .scaleEffect(1.2)
                .frame(height: 160)
                .padding(.top, 26)
            Button("Start work", action: startWork)
                .buttonStyle(.borderedProminent).controlSize(.large)
                .padding(.top, 24)
                .keyboardShortcut(.return, modifiers: [])
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    static let sleepingCrew: [AgentSnapshot] = [
        ("explorer", "xp", "#64D2FF"), ("architect", "mosby", "#BF5AF2"),
        ("developer", "denver", "#30D158"), ("reviewer", "four eyes", "#FFD60A"),
        ("security", "firewall", "#FF453A"), ("tester", "qually", "#0A84FF")
    ].map { AgentSnapshot(id: $0.0, role: $0.0, name: $0.1, color: $0.2, state: "idle", detail: "", sessionID: nil) }
}
