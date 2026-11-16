import SwiftUI

extension Color {
    init(agentHex: String) {
        let hex = UInt64(agentHex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x8E8E93
        self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}

/// A vector translation of the CLI's dumpling workers and industrial skyline.
struct FactoryScene: View {
    let agents: [AgentSnapshot]
    let visible: Bool
    var state: String = "idle"
    var snoozing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    private var moving: Bool { visible && !reduceMotion && (snoozing || agents.contains(where: \.active)) }
    private var workingMotion: Bool { moving && !snoozing }

    var body: some View {
        TimelineView(.animation(minimumInterval: snoozing ? 1.0 / 8 : 1.0 / 12, paused: !moving)) { timeline in
            Canvas { context, size in
                let time = moving ? timeline.date.timeIntervalSinceReferenceDate : 0
                let ink = Color.primary.opacity(scheme == .dark ? 0.45 : 0.35)
                // Sawtooth roof, chimney and lit bays echo src/factory.js.
                var skyline = Path()
                skyline.move(to: CGPoint(x: 18, y: 64))
                skyline.addLine(to: CGPoint(x: 18, y: 30))
                skyline.addLine(to: CGPoint(x: 27, y: 30))
                skyline.addLine(to: CGPoint(x: 27, y: 47))
                for index in 0..<3 {
                    let x = 27 + CGFloat(index) * 19
                    skyline.addLine(to: CGPoint(x: x + 19, y: 36))
                    skyline.addLine(to: CGPoint(x: x + 19, y: 47))
                }
                skyline.addLine(to: CGPoint(x: 84, y: 64))
                context.stroke(skyline, with: .color(ink), style: StrokeStyle(lineWidth: 1.4, lineCap: .round, lineJoin: .round))
                for index in 0..<4 {
                    let rect = CGRect(x: 34 + CGFloat(index) * 12, y: 51, width: 5, height: 8)
                    context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(workingMotion ? .yellow.opacity(0.8) : ink.opacity(0.4)))
                }
                if agents.contains(where: \.active) {
                    for index in 0..<3 {
                        let phase = (time / 3 + Double(index) / 3).truncatingRemainder(dividingBy: 1)
                        let rect = CGRect(x: 21 + phase * 12, y: 24 - phase * 19, width: 4 + phase * 5, height: 3 + phase * 4)
                        context.fill(Path(ellipseIn: rect), with: .color(ink.opacity(1 - phase)))
                    }
                }
                let crew = displayedAgents(agents)
                let count = max(crew.count, 1)
                let spacing = (size.width - 28) / CGFloat(count)
                for (index, agent) in crew.enumerated() {
                    let x = 14 + spacing * (CGFloat(index) + 0.5)
                    let phase = time * 5 + Double(index) * 1.7
                    let bob = snoozing && moving ? sin(phase * 0.25) * 0.8 : agent.active && moving ? sin(phase) * 1.4 : 0
                    drawWorker(context: &context, center: CGPoint(x: x, y: 83 + bob), agent: agent, phase: phase)
                    if snoozing {
                        let drift = moving ? (time / 4 + Double(index) / 6).truncatingRemainder(dividingBy: 1) : 0.4
                        context.draw(Text("z").font(.system(size: 9, weight: .medium)).foregroundColor(.secondary.opacity(1 - drift * 0.6)), at: CGPoint(x: x + 12 + drift * 4, y: 62 - drift * 13))
                    }
                }
                // Shared production line. Only the actual active crew moves it.
                let belt = CGRect(x: 16, y: 106, width: size.width - 32, height: 7)
                context.stroke(Path(roundedRect: belt, cornerRadius: 3.5), with: .color(ink), lineWidth: 1)
                for index in 0..<12 {
                    let offset = workingMotion ? CGFloat(time * 9).truncatingRemainder(dividingBy: 25) : 0
                    let x = 23 + CGFloat(index) * 25 + offset
                    if x < size.width - 20 { context.fill(Path(ellipseIn: CGRect(x: x, y: 108, width: 2, height: 2)), with: .color(ink)) }
                }
                if !snoozing {
                    let caption = sceneCaption(agents: agents, state: state)
                    context.draw(Text(caption).font(.system(size: 10, weight: .medium)).foregroundColor(.secondary), at: CGPoint(x: size.width - 16, y: 38), anchor: .trailing)
                }
            }
        }
        .frame(height: 126)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(snoozing ? "The crew is snoozing. Idle." : "Factory floor. \(agents.filter(\.active).count) agents working.")
    }

    private func drawWorker(context: inout GraphicsContext, center: CGPoint, agent: AgentSnapshot, phase: Double) {
        let color = agent.role == "orchestrator" ? Color.primary : Color(agentHex: agent.color)
        let working = agent.active
        let body = CGRect(x: center.x - 12, y: center.y - 12, width: 24, height: 23)
        let outline = Path(roundedRect: body, cornerRadius: 9)
        context.fill(outline, with: .color(color.opacity(scheme == .dark ? 0.15 : 0.22)))
        context.stroke(outline, with: .color(color.opacity(working || agent.state == "completed" ? 1 : 0.6)), lineWidth: 1.6)
        // Dumpling pleat, feet, arms and blinking eyes.
        var lines = Path()
        lines.move(to: CGPoint(x: center.x - 3, y: center.y - 12))
        lines.addQuadCurve(to: CGPoint(x: center.x + 2, y: center.y - 7), control: CGPoint(x: center.x + 1, y: center.y - 12))
        for side: CGFloat in [-1, 1] {
            lines.move(to: CGPoint(x: center.x + side * 6, y: center.y + 12))
            lines.addLine(to: CGPoint(x: center.x + side * 8, y: center.y + 14))
            lines.move(to: CGPoint(x: center.x + side * 13, y: center.y + 1))
            lines.addLine(to: CGPoint(x: center.x + side * 17, y: center.y + (working ? sin(phase + Double(side)) * 3 : 4)))
        }
        context.stroke(lines, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        let blink = working && moving && sin(phase / 3) > 0.98
        let eyeColor = Color.primary.opacity(agent.state == "idle" ? 0.45 : 0.85)
        for side: CGFloat in [-1, 1] {
            if snoozing {
                var eye = Path()
                eye.move(to: CGPoint(x: center.x + side * 4 - 2, y: center.y - 2))
                eye.addQuadCurve(to: CGPoint(x: center.x + side * 4 + 2, y: center.y - 2), control: CGPoint(x: center.x + side * 4, y: center.y))
                context.stroke(eye, with: .color(eyeColor), style: StrokeStyle(lineWidth: 1, lineCap: .round))
            } else {
                let eye = CGRect(x: center.x + side * 4 - 1, y: center.y - 3, width: 2, height: blink ? 0.8 : 2.5)
                context.fill(Path(ellipseIn: eye), with: .color(eyeColor))
            }
        }
        var smile = Path()
        smile.move(to: CGPoint(x: center.x - 2, y: center.y + 3))
        smile.addQuadCurve(to: CGPoint(x: center.x + 2, y: center.y + 3), control: CGPoint(x: center.x, y: center.y + (agent.needsAttention ? 1 : 6)))
        context.stroke(smile, with: .color(eyeColor), style: StrokeStyle(lineWidth: 1, lineCap: .round))
        if agent.role == "reviewer" {
            for side: CGFloat in [-1, 1] {
                context.stroke(Path(roundedRect: CGRect(x: center.x + side * 4 - 3, y: center.y - 5, width: 6, height: 6), cornerRadius: 1), with: .color(color), lineWidth: 1)
            }
        }
        if working && agent.role == "developer" {
            let laptop = CGRect(x: center.x + 11, y: center.y + 2, width: 12, height: 8)
            context.fill(Path(roundedRect: laptop, cornerRadius: 1), with: .color(Color(nsColor: .windowBackgroundColor)))
            context.stroke(Path(roundedRect: laptop, cornerRadius: 1), with: .color(color), lineWidth: 1)
        }
        if agent.state == "completed" {
            context.draw(Text(Image(systemName: "checkmark")).font(.system(size: 8, weight: .bold)).foregroundColor(color), at: CGPoint(x: center.x + 15, y: center.y - 14))
        } else if agent.needsAttention {
            context.draw(Text("!").font(.system(size: 10, weight: .bold)).foregroundColor(.orange), at: CGPoint(x: center.x + 15, y: center.y - 14))
        }
    }

    static func displayedAgents(_ agents: [AgentSnapshot]) -> [AgentSnapshot] {
        Array((agents.filter(\.active) + agents.filter { !$0.active && $0.role != "orchestrator" }).prefix(6))
    }

    private func displayedAgents(_ agents: [AgentSnapshot]) -> [AgentSnapshot] { Self.displayedAgents(agents) }

    static func sceneCaption(agents: [AgentSnapshot], state: String) -> String {
        if state == "blocked" || state == "error" || agents.contains(where: \.needsAttention) { return "The crew needs a hand." }
        if agents.contains(where: \.active) { return "A little team. Real work." }
        if state == "done" { return "Work complete. Time to recharge." }
        if state == "aborted" { return "This run was cancelled." }
        return "Ready for the next idea."
    }

    private func sceneCaption(agents: [AgentSnapshot], state: String) -> String { Self.sceneCaption(agents: agents, state: state) }
}
