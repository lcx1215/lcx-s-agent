import SwiftUI

struct LCXAgentControlRoomView: View {
    @Bindable var store: LCXAgentControlRoomStore

    private let columns = [
        GridItem(.adaptive(minimum: 240, maximum: 340), spacing: 14, alignment: .top),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                self.header
                self.summaryStrip
                LCXFarmMapView(departments: self.store.snapshot.departments)
                LazyVGrid(columns: self.columns, alignment: .leading, spacing: 14) {
                    ForEach(self.store.snapshot.departments) { department in
                        LCXAgentDepartmentCard(department: department)
                    }
                }
                self.proofBoard
            }
            .padding(22)
        }
        .background(self.background)
        .frame(minWidth: 860, minHeight: 620)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            LCXControlRoomMascot(tone: self.store.snapshot.activeHeavy ? .busy : .good)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 8) {
                Text("LCX Agent Farm")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                Text("把智能体当成一座农场：总管排班、温室训练、工坊打磨技能、渔港等 live proof。只读展示 owner snapshot，不启动训练，不触碰 live/provider/protected memory。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    self.statusPill("checked \(self.store.snapshot.checkedAt)", image: "clock", tone: .neutral)
                    self.statusPill(self.store.snapshot.sourceReadStatus, image: "doc.text.magnifyingglass", tone: .good)
                }
            }

            Spacer(minLength: 12)

            Button {
                self.store.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var summaryStrip: some View {
        HStack(spacing: 10) {
            LCXMetricTile(
                title: "地块",
                value: "\(self.store.snapshot.repoDirtyCount)",
                caption: "dirty files",
                systemImage: "folder.badge.gearshape",
                tone: self.store.snapshot.repoDirtyCount == 0 ? .good : .waiting)
            LCXMetricTile(
                title: "农机",
                value: "\(self.store.snapshot.activePidCounts.values.reduce(0, +))",
                caption: self.store.snapshot.activeHeavy ? "busy" : "idle",
                systemImage: "cpu",
                tone: self.store.snapshot.activeHeavy ? .busy : .good)
            LCXMetricTile(
                title: "作物",
                value: self.store.snapshot.promotionReady ? "Ready" : "Hold",
                caption: "failed \(self.store.snapshot.failedCaseCount), recovered \(self.store.snapshot.parseRecoveredCount)",
                systemImage: "carrot",
                tone: self.store.snapshot.promotionReady ? .good : .waiting)
            LCXMetricTile(
                title: "新农具",
                value: "\(self.store.snapshot.blacktechRoutedCount)/\(self.store.snapshot.blacktechMechanismCount)",
                caption: "owner routed",
                systemImage: "sparkles",
                tone: .good)
        }
    }

    private var proofBoard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Proof Board")
                .font(.title3.weight(.semibold))
            HStack(alignment: .top, spacing: 14) {
                self.proofPanel(
                    title: "下一件农活",
                    image: "figure.walk.motion",
                    lines: [self.store.snapshot.fastestSafeNextAction])
                self.proofPanel(
                    title: "缺的出港单",
                    image: "paperplane",
                    lines: self.store.snapshot.liveBindingMissingProof.isEmpty
                        ? ["No missing proof reported."]
                        : self.store.snapshot.liveBindingMissingProof)
                self.proofPanel(
                    title: "Handoff",
                    image: "tray.full",
                    lines: [
                        "generated: \(self.store.snapshot.handoffGeneratedAt)",
                        "boundary: \(self.store.snapshot.handoffBoundary)",
                        self.store.snapshot.handoffPath,
                    ])
            }
        }
    }

    private func proofPanel(title: String, image: String, lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: image)
                .font(.headline)
            ForEach(Array(lines.prefix(7).enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.white.opacity(0.55), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func statusPill(_ text: String, image: String, tone: LCXAgentDepartment.Tone) -> some View {
        Label(text, systemImage: image)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(LCXPalette.color(for: tone).opacity(0.14), in: Capsule())
            .foregroundStyle(LCXPalette.color(for: tone))
    }

    private var background: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            LinearGradient(
                colors: [
                    Color(red: 0.98, green: 0.99, blue: 0.93),
                    Color(red: 0.91, green: 0.97, blue: 1.0),
                    Color(red: 1.0, green: 0.94, blue: 0.96),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            .opacity(0.65)
        }
        .ignoresSafeArea()
    }
}

private struct LCXFarmMapView: View {
    let departments: [LCXAgentDepartment]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Farm Work Map")
                    .font(.title3.weight(.semibold))
                Spacer()
                Text("owner snapshots -> departments -> proof board")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .center, spacing: 10) {
                    ForEach(self.departments) { department in
                        LCXFarmPlot(department: department)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

private struct LCXFarmPlot: View {
    let department: LCXAgentDepartment

    var body: some View {
        VStack(spacing: 7) {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(self.soil)
                    .overlay(
                        VStack(spacing: 5) {
                            ForEach(0..<4, id: \.self) { _ in
                                Capsule()
                                    .fill(Color.white.opacity(0.22))
                                    .frame(height: 3)
                            }
                        }
                        .padding(.horizontal, 9))
                Image(systemName: self.department.systemImage)
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(LCXPalette.color(for: self.department.tone))
                    .frame(width: 42, height: 42)
                    .background(Color.white.opacity(0.78), in: RoundedRectangle(cornerRadius: 8))
            }
            .frame(width: 108, height: 72)
            Text(self.department.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .frame(width: 112)
            Text(self.shortStatus)
                .font(.caption2)
                .foregroundStyle(LCXPalette.color(for: self.department.tone))
                .lineLimit(1)
                .frame(width: 112)
        }
        .padding(9)
        .background(Color.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var soil: Color {
        switch self.department.tone {
        case .good:
            Color(red: 0.75, green: 0.86, blue: 0.52)
        case .busy:
            Color(red: 0.64, green: 0.79, blue: 0.95)
        case .waiting:
            Color(red: 0.90, green: 0.76, blue: 0.48)
        case .blocked:
            Color(red: 0.88, green: 0.57, blue: 0.54)
        case .neutral:
            Color(red: 0.78, green: 0.76, blue: 0.70)
        }
    }

    private var shortStatus: String {
        if self.department.status.count <= 18 { return self.department.status }
        return String(self.department.status.prefix(18)) + "..."
    }
}

private struct LCXAgentDepartmentCard: View {
    let department: LCXAgentDepartment

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                LCXControlRoomMascot(tone: self.department.tone)
                    .frame(width: 54, height: 54)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(self.department.title)
                        .font(.headline.weight(.bold))
                    Text(self.department.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Image(systemName: self.department.systemImage)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(LCXPalette.color(for: self.department.tone))
            }

            Text(self.department.status)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(LCXPalette.color(for: self.department.tone))
                .fixedSize(horizontal: false, vertical: true)
            Text(self.department.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 188, alignment: .topLeading)
        .background(Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(LCXPalette.color(for: self.department.tone).opacity(0.26), lineWidth: 1))
    }
}

private struct LCXMetricTile: View {
    let title: String
    let value: String
    let caption: String
    let systemImage: String
    let tone: LCXAgentDepartment.Tone

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: self.systemImage)
                .font(.title2.weight(.bold))
                .foregroundStyle(LCXPalette.color(for: self.tone))
                .frame(width: 34, height: 34)
                .background(LCXPalette.color(for: self.tone).opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(self.value)
                    .font(.title3.weight(.bold))
                    .lineLimit(1)
                Text(self.caption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 82)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct LCXControlRoomMascot: View {
    let tone: LCXAgentDepartment.Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(LCXPalette.color(for: self.tone).opacity(0.18))
                .rotationEffect(.degrees(-5))
            Circle()
                .fill(Color.white.opacity(0.95))
                .padding(7)
            Circle()
                .fill(LCXPalette.color(for: self.tone).opacity(0.22))
                .padding(13)
            HStack(spacing: 10) {
                Circle().fill(Color.primary).frame(width: 5, height: 5)
                Circle().fill(Color.primary).frame(width: 5, height: 5)
            }
            .offset(y: -4)
            Capsule()
                .fill(LCXPalette.color(for: self.tone))
                .frame(width: 18, height: 5)
                .offset(y: 11)
            Image(systemName: self.symbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(LCXPalette.color(for: self.tone))
                .offset(y: -23)
        }
    }

    private var symbol: String {
        switch self.tone {
        case .good: "checkmark"
        case .busy: "gearshape.2"
        case .waiting: "hourglass"
        case .blocked: "exclamationmark"
        case .neutral: "circle.grid.2x2"
        }
    }
}

private enum LCXPalette {
    static func color(for tone: LCXAgentDepartment.Tone) -> Color {
        switch tone {
        case .good:
            Color(red: 0.10, green: 0.52, blue: 0.39)
        case .busy:
            Color(red: 0.10, green: 0.36, blue: 0.72)
        case .waiting:
            Color(red: 0.74, green: 0.42, blue: 0.09)
        case .blocked:
            Color(red: 0.72, green: 0.16, blue: 0.21)
        case .neutral:
            Color(red: 0.36, green: 0.36, blue: 0.42)
        }
    }
}

struct LCXAgentControlRoomView_Previews: PreviewProvider {
    static var previews: some View {
        LCXAgentControlRoomView(store: LCXAgentControlRoomStore(snapshot: .build(
            autopilot: [
                "ok": true,
                "checkedAt": "2026-05-27T22:44:40Z",
                "summary": [
                    "parsedOwners": 13,
                    "activeTrainingOrEval": true,
                    "blockedClusters": ["module_learning_absorption_cluster"],
                    "blockedGates": ["live_runtime_not_updated"],
                    "fastestSafeNextAction": "wait_for_current_training_eval_then_run_idle_queue",
                    "externalUpgradeBlacktechMechanismCount": 6,
                    "externalUpgradeBlacktechAutopilotRoutedCount": 6,
                ],
            ],
            digest: [
                "material": [
                    "repoDirtyCount": 35,
                    "activeHeavy": true,
                    "activePidCounts": ["guard": 1, "eval": 1, "mlx": 1],
                    "liveLarkBrainBindingStatus": "deferred_active_training_or_eval",
                    "skillOptLiteStatus": "candidate_edit_static_accepted_pending_eval",
                    "providerCouncilAccelerationStatus": "ready_plan",
                    "providerCouncilAccelerationAction": "dry_run_plan_only",
                ],
            ],
            handoff: "generatedAt: 2026-05-27T22:44:40Z\nboundary: dev_context_recovery_handoff_only\n",
            handoffPath: "/tmp/lcx-context-recovery-handoff-latest.md")))
    }
}
