import AppKit
import SwiftUI

private struct Department: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let status: String
    let detail: String
    let image: String
    let tone: Tone
}

private enum Tone {
    case good
    case busy
    case waiting
    case blocked
    case neutral
}

private struct FarmSnapshot {
    let checkedAt: String
    let dirtyCount: Int
    let activeHeavyCount: Int
    let selectedCleanAdapter: String
    let candidateAdapter: String
    let parseRecoveredCount: Int
    let liveStatus: String
    let missingLiveProofCount: Int
    let skillOptStatus: String
    let skillOptSkills: [String]
    let blacktechRouted: Int
    let blacktechTotal: Int
    let providerStatus: String
    let providerBlocks: [String]
    let nextAction: String
    let activePidCounts: [String: Int]

    static func load() -> FarmSnapshot {
        let stateDir = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw/workspace/state", isDirectory: true)
        let autopilot = Self.readJSON(stateDir.appendingPathComponent("lcx-governance-autopilot-latest.json"))
        let digest = Self.readJSON(stateDir.appendingPathComponent("lcx-evolution-promotion-digest-latest.json"))
        let summary = dict(autopilot, "summary")
        let material = dict(digest, "material")
        let candidate = dict(material, "latestCandidateEval")
        let pids = intDict(material, "activePidCounts")
        let liveProof = strings(material, "liveBindingMissingProof")
        return FarmSnapshot(
            checkedAt: string(digest, "checkedAt") ?? string(autopilot, "checkedAt") ?? "not available",
            dirtyCount: int(material, "repoDirtyCount") ?? int(summary, "universeIndexDirtyFiles") ?? 0,
            activeHeavyCount: pids.values.reduce(0, +),
            selectedCleanAdapter: lastPath(string(material, "selectedCleanAdapter") ?? "not selected"),
            candidateAdapter: lastPath(string(candidate, "adapterPath") ?? "not available"),
            parseRecoveredCount: strings(candidate, "parseRecoveredCaseIds").count,
            liveStatus: string(material, "liveLarkBrainBindingStatus") ?? "unknown",
            missingLiveProofCount: liveProof.count,
            skillOptStatus: string(material, "skillOptLiteStatus") ?? string(summary, "skillOptLiteStatus") ?? "unknown",
            skillOptSkills: strings(material, "skillOptLiteMatchedSkillIds"),
            blacktechRouted: int(material, "externalUpgradeBlacktechAutopilotRoutedCount")
                ?? int(summary, "externalUpgradeBlacktechAutopilotRoutedCount")
                ?? 0,
            blacktechTotal: int(material, "externalUpgradeBlacktechMechanismCount")
                ?? int(summary, "externalUpgradeBlacktechMechanismCount")
                ?? 0,
            providerStatus: string(material, "providerCouncilAccelerationStatus") ?? "unknown",
            providerBlocks: strings(material, "providerCouncilAccelerationHardBlocks"),
            nextAction: string(material, "fastestSafeNextAction")
                ?? string(summary, "fastestSafeNextAction")
                ?? "refresh owner state",
            activePidCounts: pids)
    }

    var terminalLaneSummary: String {
        let active = self.activePidCounts
            .filter { $0.value > 0 }
            .sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)" }
        return active.isEmpty ? "当前没有重作业终端" : active.joined(separator: " / ")
    }

    var remoteDevboxStatus: String {
        let sshConfig = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh/config")
        if FileManager.default.fileExists(atPath: sshConfig.path) {
            return "可接 SSH Host，需在 Codex 设置选择远程项目"
        }
        return "未发现 ~/.ssh/config，先添加 Host alias"
    }

    var lockedComputerUseStatus: String {
        "需要在 Codex 设置手动启用并授权 Screen Recording / Accessibility"
    }

    var webDashboardURL: URL {
        URL(string: "http://127.0.0.1:4788")!
    }

    var departments: [Department] {
        [
            Department(
                id: "farmhouse",
                title: "农场总管屋",
                subtitle: "Governance Farmhouse",
                status: "owner 快照 \(self.checkedAt)",
                detail: "负责总调度：雷达、商业验收、mind model、flow graph、head-tail。",
                image: "house.and.flag",
                tone: .good),
            Department(
                id: "greenhouse",
                title: "大脑温室",
                subtitle: "Qwen / MiniMax / MLX",
                status: self.activeHeavyCount > 0 ? "\(self.activeHeavyCount) 台农机在跑" : "空闲",
                detail: "clean 种苗: \(self.selectedCleanAdapter); 候选作物: \(self.candidateAdapter); 返修苗 \(self.parseRecoveredCount)。",
                image: "leaf",
                tone: self.activeHeavyCount > 0 ? .busy : .good),
            Department(
                id: "skillopt",
                title: "技能工坊",
                subtitle: "SkillOpt Tool Shed",
                status: self.skillOptStatus,
                detail: self.skillOptSkills.isEmpty
                    ? "等错题和用户反馈进来。"
                    : "正在把错题做成工具: \(self.skillOptSkills.joined(separator: ", "))。",
                image: "hammer",
                tone: self.skillOptStatus.contains("pending") ? .waiting : .good),
            Department(
                id: "lark",
                title: "LiveLark 渔港",
                subtitle: "Real Lark Shipping Dock",
                status: self.liveStatus,
                detail: "还缺 \(self.missingLiveProofCount) 张出港单，不能冒充 live-fixed。",
                image: "sailboat",
                tone: self.liveStatus.contains("deferred") ? .waiting : .good),
            Department(
                id: "silo",
                title: "知识谷仓",
                subtitle: "Receipts / Absorption",
                status: "沉淀要过吸收闸",
                detail: "receipt 只是入库，不等于模型权重已经学会。",
                image: "building.columns",
                tone: .waiting),
            Department(
                id: "council",
                title: "三家议事棚",
                subtitle: "Provider Council",
                status: self.providerStatus,
                detail: self.providerBlocks.isEmpty ? "可等待 owner 写入窗口。" : "硬阻塞: \(self.providerBlocks.joined(separator: ", "))",
                image: "person.3",
                tone: self.providerBlocks.isEmpty ? .good : .blocked),
            Department(
                id: "workshop",
                title: "黑科技发明棚",
                subtitle: "External Upgrades",
                status: "\(self.blacktechRouted)/\(self.blacktechTotal) 已接 owner 路由",
                detail: "外部机制只当新农具，不直接给 runtime/live/provider 权限。",
                image: "wrench.and.screwdriver",
                tone: .good),
            Department(
                id: "fence",
                title: "安全栅栏",
                subtitle: "Boundaries",
                status: "\(self.dirtyCount) 个 dirty 文件",
                detail: self.nextAction,
                image: "lock.shield",
                tone: self.dirtyCount == 0 ? .good : .waiting),
        ]
    }

    private static func readJSON(_ url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return root
    }
}

private final class Store: ObservableObject {
    @Published var snapshot = FarmSnapshot.load()

    func refresh() {
        self.snapshot = FarmSnapshot.load()
    }
}

@main
private struct LCXAgentFarmApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup("LCX Agent Farm") {
            ContentView(store: self.store)
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1120, height: 760)
    }
}

private struct ContentView: View {
    @ObservedObject var store: Store

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                FarmGround()
                FarmScene(departments: self.store.snapshot.departments)
                    .padding(.top, 74)
                    .padding(.bottom, 96)
                    .padding(.horizontal, 18)
                FarmTopHUD(snapshot: self.store.snapshot) {
                    self.store.refresh()
                }
                .padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                StatusSign(snapshot: self.store.snapshot)
                    .frame(width: min(330, proxy.size.width * 0.31))
                    .padding(.trailing, 18)
                    .padding(.top, 90)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                CodexBridgePanel(snapshot: self.store.snapshot)
                    .frame(width: min(350, proxy.size.width * 0.33))
                    .padding(.trailing, 18)
                    .padding(.bottom, 98)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                FarmToolbelt(departments: self.store.snapshot.departments)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 14)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
        .frame(minWidth: 980, minHeight: 690)
    }
}

private struct CodexBridgePanel: View {
    let snapshot: FarmSnapshot

    var body: some View {
        WoodenPanel {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                    Text("Codex 桥接农具")
                        .font(.headline.weight(.black))
                }
                Divider().overlay(Color(red: 0.54, green: 0.28, blue: 0.10))
                bridgeLine("Web 前端", "给 in-app browser / 手机 / 远程看农场", "safari")
                bridgeLine("多个终端", self.snapshot.terminalLaneSummary, "terminal")
                bridgeLine("远程 devbox", self.snapshot.remoteDevboxStatus, "externaldrive.connected.to.line.below")
                bridgeLine("Locked Use", self.snapshot.lockedComputerUseStatus, "lock.laptopcomputer")
                HStack(spacing: 8) {
                    Button {
                        NSWorkspace.shared.open(self.snapshot.webDashboardURL)
                    } label: {
                        Label("打开 Web 农场", systemImage: "safari")
                            .font(.caption.weight(.bold))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color(red: 0.96, green: 0.76, blue: 0.42), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(red: 0.44, green: 0.22, blue: 0.08), lineWidth: 2))
                    Button {
                        NSWorkspace.shared.open(URL(fileURLWithPath: "/Users/liuchengxu/Desktop/lcx-s-openclaw/ops/codex-remote-devbox-and-browser-runbook.md"))
                    } label: {
                        Label("远程接入手册", systemImage: "book")
                            .font(.caption.weight(.bold))
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color(red: 0.93, green: 0.72, blue: 0.42), in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(red: 0.44, green: 0.22, blue: 0.08), lineWidth: 2))
                }
                .foregroundStyle(Color(red: 0.26, green: 0.12, blue: 0.05))
            }
            .foregroundStyle(Color(red: 0.26, green: 0.12, blue: 0.05))
        }
    }

    private func bridgeLine(_ label: String, _ value: String, _ symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol)
                .font(.caption.weight(.black))
                .frame(width: 16)
            Text(label)
                .font(.caption.weight(.bold))
            Spacer(minLength: 8)
            Text(value)
                .font(.caption2.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct FarmTopHUD: View {
    let snapshot: FarmSnapshot
    let onRefresh: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            WoodenPanel {
                HStack(spacing: 12) {
                    Mascot(tone: self.snapshot.activeHeavyCount > 0 ? .busy : .good)
                        .frame(width: 50, height: 50)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("LCX Agent Farm")
                            .font(.system(size: 22, weight: .black, design: .rounded))
                            .foregroundStyle(Color(red: 0.25, green: 0.12, blue: 0.05))
                        Text("只读 owner 快照 - 不启动训练 / 不碰 live/provider/protected memory")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color(red: 0.42, green: 0.23, blue: 0.10))
                    }
                }
            }

            Spacer(minLength: 10)

            WoodenPanel {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Day \(self.dayNumber)", systemImage: "sun.max.fill")
                    Label(self.snapshot.checkedAt, systemImage: "clock")
                    Label("\(self.snapshot.activeHeavyCount) farmhands busy", systemImage: "gearshape.2")
                }
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(red: 0.26, green: 0.12, blue: 0.05))
                .lineLimit(1)
            }

            Button {
                self.onRefresh()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.title3.weight(.bold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .background(Color(red: 0.96, green: 0.76, blue: 0.42), in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color(red: 0.44, green: 0.22, blue: 0.08), lineWidth: 2))
        }
    }

    private var dayNumber: Int {
        max(1, self.snapshot.dirtyCount + self.snapshot.activeHeavyCount)
    }
}

private struct FarmGround: View {
    var body: some View {
        ZStack {
            Color(red: 0.47, green: 0.73, blue: 0.36)
            TilePattern()
                .opacity(0.30)
            Path { path in
                path.move(to: CGPoint(x: 0, y: 470))
                path.addCurve(
                    to: CGPoint(x: 1200, y: 350),
                    control1: CGPoint(x: 250, y: 380),
                    control2: CGPoint(x: 700, y: 540))
            }
            .stroke(Color(red: 0.72, green: 0.56, blue: 0.31), style: StrokeStyle(lineWidth: 52, lineCap: .round))
            Path { path in
                path.move(to: CGPoint(x: 690, y: 0))
                path.addCurve(
                    to: CGPoint(x: 520, y: 780),
                    control1: CGPoint(x: 570, y: 160),
                    control2: CGPoint(x: 760, y: 520))
            }
            .stroke(Color(red: 0.68, green: 0.49, blue: 0.25), style: StrokeStyle(lineWidth: 38, lineCap: .round))
            RoundedRectangle(cornerRadius: 40)
                .fill(Color(red: 0.25, green: 0.58, blue: 0.80))
                .overlay(WaveLines().stroke(.white.opacity(0.25), lineWidth: 2))
                .frame(width: 260, height: 180)
                .offset(x: 445, y: 190)
            ForEach(0..<16, id: \.self) { index in
                TreeShape()
                    .frame(width: 38, height: 54)
                    .offset(x: self.treeX(index), y: self.treeY(index))
            }
        }
        .ignoresSafeArea()
    }

    private func treeX(_ index: Int) -> CGFloat {
        let values: [CGFloat] = [-500, -440, -360, -280, -190, -70, 40, 170, 300, 430, 500, -520, -420, 380, 470, 530]
        return values[index % values.count]
    }

    private func treeY(_ index: Int) -> CGFloat {
        let values: [CGFloat] = [-300, -220, -330, 250, 310, -260, 300, -320, 270, -250, 60, 80, 150, -80, -170, 270]
        return values[index % values.count]
    }
}

private struct FarmScene: View {
    let departments: [Department]

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                ForEach(Array(self.departments.enumerated()), id: \.element.id) { index, department in
                    FarmSceneNode(department: department, seed: Double(index))
                        .frame(width: self.nodeSize(for: proxy.size).width, height: self.nodeSize(for: proxy.size).height)
                        .position(self.position(for: department.id, in: proxy.size))
                }
            }
        }
    }

    private func nodeSize(for size: CGSize) -> CGSize {
        CGSize(width: max(140, min(210, size.width * 0.18)), height: 132)
    }

    private func position(for id: String, in size: CGSize) -> CGPoint {
        let points: [String: CGPoint] = [
            "farmhouse": CGPoint(x: size.width * 0.18, y: size.height * 0.20),
            "greenhouse": CGPoint(x: size.width * 0.45, y: size.height * 0.22),
            "skillopt": CGPoint(x: size.width * 0.24, y: size.height * 0.50),
            "lark": CGPoint(x: size.width * 0.76, y: size.height * 0.48),
            "silo": CGPoint(x: size.width * 0.45, y: size.height * 0.58),
            "council": CGPoint(x: size.width * 0.63, y: size.height * 0.28),
            "workshop": CGPoint(x: size.width * 0.62, y: size.height * 0.72),
            "fence": CGPoint(x: size.width * 0.18, y: size.height * 0.78),
        ]
        return points[id] ?? CGPoint(x: size.width * 0.5, y: size.height * 0.5)
    }
}

private struct FarmSceneNode: View {
    let department: Department
    let seed: Double

    var body: some View {
        ZStack {
            if self.department.id == "greenhouse" || self.department.id == "skillopt" || self.department.id == "fence" {
                FarmField(tone: self.department.tone)
                    .frame(width: 150, height: 84)
                    .offset(y: 20)
            }
            FarmBuilding(department: self.department)
                .offset(y: self.department.id == "lark" ? 20 : -10)
            FarmWorker(tone: self.department.tone, role: self.department.id, seed: self.seed)
                .scaleEffect(0.86)
                .offset(x: -44, y: 38)
            WoodenSign(title: self.department.title, status: self.department.status, tone: self.department.tone)
                .offset(y: 74)
        }
    }
}

private struct FarmBuilding: View {
    let department: Department

    var body: some View {
        ZStack {
            switch self.department.id {
            case "farmhouse":
                HouseBuilding(tone: self.department.tone)
            case "greenhouse":
                GreenhouseBuilding(tone: self.department.tone)
            case "skillopt":
                ShedBuilding(tone: self.department.tone)
            case "lark":
                DockBuilding(tone: self.department.tone)
            case "silo":
                SiloBuilding(tone: self.department.tone)
            case "council":
                CoopBuilding(tone: self.department.tone)
            case "workshop":
                WorkshopBuilding(tone: self.department.tone)
            default:
                FenceBuilding(tone: self.department.tone)
            }
            Image(systemName: self.department.image)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
                .shadow(radius: 2)
                .offset(y: 4)
        }
    }
}

private struct StatusSign: View {
    let snapshot: FarmSnapshot

    var body: some View {
        WoodenPanel {
            VStack(alignment: .leading, spacing: 9) {
                Text("今日农活")
                    .font(.headline.weight(.black))
                Divider().overlay(Color(red: 0.54, green: 0.28, blue: 0.10))
                statusLine("大脑温室", "\(self.snapshot.activeHeavyCount) 个重任务")
                statusLine("LiveLark 渔港", self.snapshot.liveStatus)
                statusLine("SkillOpt 工坊", self.snapshot.skillOptStatus)
                statusLine("黑科技发明棚", "\(self.snapshot.blacktechRouted)/\(self.snapshot.blacktechTotal)")
                Text(self.snapshot.nextAction)
                    .font(.caption)
                    .foregroundStyle(Color(red: 0.32, green: 0.16, blue: 0.06))
                    .lineLimit(4)
                    .padding(.top, 4)
            }
            .foregroundStyle(Color(red: 0.26, green: 0.12, blue: 0.05))
        }
    }

    private func statusLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.caption.weight(.bold))
            Spacer(minLength: 8)
            Text(value)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
    }
}

private struct FarmToolbelt: View {
    let departments: [Department]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(self.departments) { department in
                VStack(spacing: 4) {
                    Image(systemName: department.image)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(color(for: department.tone))
                        .frame(width: 38, height: 34)
                        .background(Color(red: 0.98, green: 0.82, blue: 0.49), in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(red: 0.42, green: 0.21, blue: 0.08), lineWidth: 2))
                    Text(department.title)
                        .font(.caption2.weight(.bold))
                        .lineLimit(1)
                        .foregroundStyle(Color(red: 0.28, green: 0.13, blue: 0.05))
                        .frame(width: 82)
                }
            }
        }
        .padding(10)
        .background(Color(red: 0.67, green: 0.36, blue: 0.14), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 0.28, green: 0.12, blue: 0.04), lineWidth: 3))
    }
}

private struct WoodenPanel<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        self.content
            .padding(12)
            .background(Color(red: 0.88, green: 0.60, blue: 0.30), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(red: 0.42, green: 0.21, blue: 0.08), lineWidth: 3))
            .shadow(color: .black.opacity(0.18), radius: 4, y: 3)
    }
}

private struct WoodenSign: View {
    let title: String
    let status: String
    let tone: Tone

    var body: some View {
        VStack(spacing: 2) {
            Text(self.title)
                .font(.caption2.weight(.black))
                .lineLimit(1)
            Text(self.shortStatus)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color(for: self.tone))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(width: 132)
        .background(Color(red: 0.93, green: 0.72, blue: 0.42), in: RoundedRectangle(cornerRadius: 5))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color(red: 0.42, green: 0.21, blue: 0.08), lineWidth: 2))
        .foregroundStyle(Color(red: 0.26, green: 0.12, blue: 0.05))
    }

    private var shortStatus: String {
        if self.status.count <= 18 { return self.status }
        return String(self.status.prefix(18)) + "..."
    }
}

private struct TilePattern: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                let step: CGFloat = 34
                var x: CGFloat = 0
                while x < proxy.size.width {
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: proxy.size.height))
                    x += step
                }
                var y: CGFloat = 0
                while y < proxy.size.height {
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: proxy.size.width, y: y))
                    y += step
                }
            }
            .stroke(Color.white.opacity(0.30), lineWidth: 1)
        }
    }
}

private struct WaveLines: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for index in 0..<5 {
            let y = rect.minY + CGFloat(index + 1) * rect.height / 6
            path.move(to: CGPoint(x: rect.minX + 18, y: y))
            path.addCurve(
                to: CGPoint(x: rect.maxX - 18, y: y),
                control1: CGPoint(x: rect.midX - 60, y: y - 14),
                control2: CGPoint(x: rect.midX + 60, y: y + 14))
        }
        return path
    }
}

private struct TreeShape: View {
    var body: some View {
        VStack(spacing: -5) {
            ZStack {
                Circle()
                    .fill(Color(red: 0.20, green: 0.52, blue: 0.25))
                    .frame(width: 32, height: 32)
                Circle()
                    .fill(Color(red: 0.30, green: 0.66, blue: 0.30))
                    .frame(width: 24, height: 24)
                    .offset(x: -5, y: -4)
            }
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(red: 0.43, green: 0.25, blue: 0.10))
                .frame(width: 9, height: 20)
        }
        .shadow(color: .black.opacity(0.18), radius: 2, y: 2)
    }
}

private struct FarmField: View {
    let tone: Tone

    var body: some View {
        RoundedRectangle(cornerRadius: 7)
            .fill(soil(for: self.tone))
            .overlay(FurrowRows(tone: self.tone).scaleEffect(0.82))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color(red: 0.38, green: 0.25, blue: 0.10), lineWidth: 2))
            .shadow(color: .black.opacity(0.12), radius: 2, y: 2)
    }
}

private struct HouseBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color(red: 0.82, green: 0.52, blue: 0.28))
                .frame(width: 82, height: 58)
                .offset(y: 20)
            Triangle()
                .fill(Color(red: 0.61, green: 0.18, blue: 0.14))
                .frame(width: 98, height: 58)
                .offset(y: -16)
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(red: 0.26, green: 0.13, blue: 0.05))
                .frame(width: 20, height: 32)
                .offset(y: 34)
            HStack(spacing: 28) {
                PixelWindow()
                PixelWindow()
            }
            .offset(y: 15)
        }
        .shadow(color: .black.opacity(0.22), radius: 3, y: 3)
    }
}

private struct GreenhouseBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(red: 0.73, green: 0.94, blue: 0.90).opacity(0.86))
                .frame(width: 92, height: 62)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.9), lineWidth: 3))
            VStack(spacing: 0) {
                Rectangle().fill(Color.white.opacity(0.65)).frame(width: 3, height: 58)
            }
            HStack(spacing: 18) {
                Rectangle().fill(Color.white.opacity(0.55)).frame(width: 3, height: 54)
                Rectangle().fill(Color.white.opacity(0.55)).frame(width: 3, height: 54)
            }
            Capsule()
                .fill(Color(red: 0.24, green: 0.55, blue: 0.32))
                .frame(width: 72, height: 14)
                .offset(y: 24)
        }
        .shadow(color: .black.opacity(0.18), radius: 3, y: 3)
    }
}

private struct ShedBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color(red: 0.70, green: 0.39, blue: 0.18))
                .frame(width: 74, height: 56)
                .offset(y: 12)
            Triangle()
                .fill(Color(red: 0.42, green: 0.22, blue: 0.10))
                .frame(width: 86, height: 45)
                .offset(y: -18)
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(red: 0.28, green: 0.15, blue: 0.07))
                .frame(width: 25, height: 35)
                .offset(y: 26)
        }
        .shadow(color: .black.opacity(0.20), radius: 3, y: 3)
    }
}

private struct DockBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            VStack(spacing: 5) {
                ForEach(0..<4, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(red: 0.55, green: 0.31, blue: 0.13))
                        .frame(width: 112, height: 10)
                }
            }
            Image(systemName: "paperplane.fill")
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(Color(red: 0.90, green: 0.96, blue: 1.0))
                .offset(x: 12, y: -18)
        }
        .shadow(color: .black.opacity(0.20), radius: 3, y: 3)
    }
}

private struct SiloBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 13)
                .fill(Color(red: 0.78, green: 0.76, blue: 0.68))
                .frame(width: 54, height: 82)
            Capsule()
                .fill(Color(red: 0.58, green: 0.20, blue: 0.15))
                .frame(width: 62, height: 22)
                .offset(y: -39)
            Rectangle()
                .fill(Color.white.opacity(0.28))
                .frame(width: 10, height: 70)
                .offset(x: -12)
        }
        .shadow(color: .black.opacity(0.20), radius: 3, y: 3)
    }
}

private struct CoopBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7)
                .fill(Color(red: 0.76, green: 0.47, blue: 0.22))
                .frame(width: 82, height: 55)
                .offset(y: 13)
            Triangle()
                .fill(Color(red: 0.50, green: 0.16, blue: 0.13))
                .frame(width: 95, height: 48)
                .offset(y: -17)
            HStack(spacing: 8) {
                Circle().fill(.white).frame(width: 15, height: 15)
                Circle().fill(.white).frame(width: 15, height: 15)
                Circle().fill(.white).frame(width: 15, height: 15)
            }
            .offset(y: 18)
        }
        .shadow(color: .black.opacity(0.20), radius: 3, y: 3)
    }
}

private struct WorkshopBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(red: 0.48, green: 0.39, blue: 0.34))
                .frame(width: 86, height: 62)
                .offset(y: 12)
            Triangle()
                .fill(Color(red: 0.25, green: 0.25, blue: 0.28))
                .frame(width: 98, height: 48)
                .offset(y: -19)
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(red: 0.96, green: 0.66, blue: 0.22))
                .frame(width: 30, height: 26)
                .offset(y: 18)
            Circle()
                .fill(Color(red: 0.96, green: 0.82, blue: 0.30))
                .frame(width: 16, height: 16)
                .offset(x: 31, y: -2)
        }
        .shadow(color: .black.opacity(0.20), radius: 3, y: 3)
    }
}

private struct FenceBuilding: View {
    let tone: Tone

    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                ForEach(0..<5, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(red: 0.65, green: 0.39, blue: 0.17))
                        .frame(width: 12, height: 62)
                }
            }
            VStack(spacing: 18) {
                RoundedRectangle(cornerRadius: 2).fill(Color(red: 0.55, green: 0.31, blue: 0.12)).frame(width: 106, height: 9)
                RoundedRectangle(cornerRadius: 2).fill(Color(red: 0.55, green: 0.31, blue: 0.12)).frame(width: 106, height: 9)
            }
        }
        .shadow(color: .black.opacity(0.18), radius: 2, y: 2)
    }
}

private struct PixelWindow: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 3)
            .fill(Color(red: 0.68, green: 0.90, blue: 1.0))
            .frame(width: 18, height: 16)
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(red: 0.28, green: 0.14, blue: 0.05), lineWidth: 2))
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct FarmMap: View {
    let departments: [Department]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Farm Work Map")
                .font(.title3.weight(.semibold))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(self.departments.enumerated()), id: \.element.id) { index, department in
                        FarmPlot(department: department, seed: Double(index))
                    }
                }
            }
        }
    }
}

private struct FarmPlot: View {
    let department: Department
    let seed: Double

    var body: some View {
        VStack(spacing: 7) {
            ZStack {
                RoundedRectangle(cornerRadius: 7)
                    .fill(soil(for: self.department.tone))
                FurrowRows(tone: self.department.tone)
                Image(systemName: self.department.image)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(color(for: self.department.tone))
                    .frame(width: 34, height: 34)
                    .background(.white.opacity(0.80), in: RoundedRectangle(cornerRadius: 8))
                    .offset(x: 31, y: -20)
                FarmWorker(tone: self.department.tone, seed: self.seed)
            }
            .frame(width: 132, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            Text(self.department.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .frame(width: 132)
            Text(self.shortStatus)
                .font(.caption2)
                .foregroundStyle(color(for: self.department.tone))
                .lineLimit(1)
                .frame(width: 132)
        }
        .padding(9)
        .background(.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 8))
    }

    private var shortStatus: String {
        if self.department.status.count <= 18 { return self.department.status }
        return String(self.department.status.prefix(18)) + "..."
    }
}

private struct FurrowRows: View {
    let tone: Tone

    var body: some View {
        VStack(spacing: 7) {
            ForEach(0..<6, id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(0..<6, id: \.self) { column in
                        Capsule()
                            .fill(self.rowColor(row: row, column: column))
                            .frame(width: 12, height: 4)
                    }
                }
            }
        }
        .padding(8)
    }

    private func rowColor(row: Int, column: Int) -> Color {
        let alternate = (row + column) % 2 == 0
        switch self.tone {
        case .good:
            return alternate ? .white.opacity(0.28) : Color.green.opacity(0.30)
        case .busy:
            return alternate ? .white.opacity(0.30) : Color.blue.opacity(0.22)
        case .waiting:
            return alternate ? .white.opacity(0.28) : Color.orange.opacity(0.24)
        case .blocked:
            return alternate ? .white.opacity(0.28) : Color.red.opacity(0.20)
        case .neutral:
            return alternate ? .white.opacity(0.28) : Color.gray.opacity(0.22)
        }
    }
}

private struct FarmWorker: View {
    let tone: Tone
    var role: String = "field"
    let seed: Double

    var body: some View {
        TimelineView(.animation) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let phase = time * 1.8 + self.seed * 0.75
            let x = self.walkRadius * sin(phase)
            let y = self.walkRadius * 0.36 * cos(phase * 0.7)
            let arm = sin(phase * 3.2) * 22
            ZStack {
                self.tool(phase: phase, arm: arm)
                VStack(spacing: 0) {
                    ZStack {
                        Circle()
                            .fill(Color(red: 0.96, green: 0.76, blue: 0.55))
                            .frame(width: 18, height: 18)
                        HStack(spacing: 5) {
                            Circle().fill(.black).frame(width: 2.8, height: 2.8)
                            Circle().fill(.black).frame(width: 2.8, height: 2.8)
                        }
                        .offset(y: 1)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(color(for: self.tone))
                            .frame(width: 24, height: 7)
                            .offset(y: -10)
                    }
                    RoundedRectangle(cornerRadius: 5)
                        .fill(color(for: self.tone))
                        .frame(width: 20, height: 24)
                    HStack(spacing: 4) {
                        Capsule()
                            .fill(Color(red: 0.20, green: 0.20, blue: 0.24))
                            .frame(width: 5, height: 15)
                            .offset(y: sin(phase * 5) * 2)
                        Capsule()
                            .fill(Color(red: 0.20, green: 0.20, blue: 0.24))
                            .frame(width: 5, height: 15)
                            .offset(y: -sin(phase * 5) * 2)
                    }
                }
                .shadow(color: .black.opacity(0.16), radius: 2, y: 2)
                self.taskBubble(phase: phase)
                    .offset(x: 24, y: -26)
            }
            .offset(x: x, y: y + 8)
        }
    }

    private var walkRadius: CGFloat {
        switch self.role {
        case "lark": 18
        case "silo": 10
        case "council": 8
        default: 28
        }
    }

    @ViewBuilder
    private func tool(phase: Double, arm: Double) -> some View {
        switch self.role {
        case "lark":
            Image(systemName: "paperplane.fill")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Color(red: 0.95, green: 0.98, blue: 1.0))
                .rotationEffect(.degrees(sin(phase * 2.0) * 10))
                .offset(x: 20 + sin(phase) * 6, y: -8 + cos(phase) * 4)
        case "silo":
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(red: 0.72, green: 0.45, blue: 0.20))
                .frame(width: 19, height: 17)
                .rotationEffect(.degrees(sin(phase * 2.4) * 5))
                .offset(x: 18, y: 6)
        case "council":
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle()
                        .fill(Color.white)
                        .frame(width: 7, height: 7)
                }
            }
            .offset(x: 20, y: -5 + sin(phase * 4) * 2)
        case "workshop":
            Image(systemName: "wrench.adjustable")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Color(red: 0.18, green: 0.18, blue: 0.20))
                .rotationEffect(.degrees(arm + 42))
                .offset(x: 16, y: 4)
        case "fence":
            Rectangle()
                .fill(Color(red: 0.65, green: 0.39, blue: 0.17))
                .frame(width: 7, height: 28)
                .rotationEffect(.degrees(arm * 0.18))
                .offset(x: 18, y: 8)
        default:
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(red: 0.35, green: 0.23, blue: 0.12))
                .frame(width: 5, height: 30)
                .overlay(
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(red: 0.70, green: 0.70, blue: 0.64))
                        .frame(width: 18, height: 5)
                        .offset(y: -13))
                .rotationEffect(.degrees(arm + 28))
                .offset(x: 14, y: 8)
        }
    }

    @ViewBuilder
    private func taskBubble(phase: Double) -> some View {
        if ["greenhouse", "skillopt", "workshop", "lark"].contains(self.role) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.82))
                    .frame(width: 20, height: 20)
                Image(systemName: self.bubbleSymbol)
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(color(for: self.tone))
            }
            .scaleEffect(1 + sin(phase * 3) * 0.08)
        }
    }

    private var bubbleSymbol: String {
        switch self.role {
        case "greenhouse": "brain.head.profile"
        case "skillopt": "hammer.fill"
        case "workshop": "sparkles"
        case "lark": "paperplane.fill"
        default: "checkmark"
        }
    }
}

private struct DepartmentCard: View {
    let department: Department

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Mascot(tone: self.department.tone)
                    .frame(width: 54, height: 54)
                VStack(alignment: .leading, spacing: 3) {
                    Text(self.department.title)
                        .font(.headline.weight(.bold))
                    Text(self.department.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: self.department.image)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(color(for: self.department.tone))
            }
            Text(self.department.status)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color(for: self.department.tone))
            Text(self.department.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 188, alignment: .topLeading)
        .background(.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(color(for: self.department.tone).opacity(0.26)))
    }
}

private struct Mascot: View {
    let tone: Tone

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(color(for: self.tone).opacity(0.17))
                .rotationEffect(.degrees(-5))
            Circle().fill(.white.opacity(0.95)).padding(7)
            Circle().fill(color(for: self.tone).opacity(0.22)).padding(13)
            HStack(spacing: 10) {
                Circle().fill(.primary).frame(width: 5, height: 5)
                Circle().fill(.primary).frame(width: 5, height: 5)
            }
            .offset(y: -4)
            Capsule()
                .fill(color(for: self.tone))
                .frame(width: 18, height: 5)
                .offset(y: 11)
            Image(systemName: self.symbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(color(for: self.tone))
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

private func dict(_ root: [String: Any], _ path: String...) -> [String: Any] {
    var current: Any = root
    for key in path {
        guard let dict = current as? [String: Any], let next = dict[key] else { return [:] }
        current = next
    }
    return current as? [String: Any] ?? [:]
}

private func string(_ root: [String: Any], _ path: String...) -> String? {
    var current: Any = root
    for key in path {
        guard let dict = current as? [String: Any], let next = dict[key] else { return nil }
        current = next
    }
    return current as? String
}

private func int(_ root: [String: Any], _ path: String...) -> Int? {
    var current: Any = root
    for key in path {
        guard let dict = current as? [String: Any], let next = dict[key] else { return nil }
        current = next
    }
    if let int = current as? Int { return int }
    if let number = current as? NSNumber { return number.intValue }
    return nil
}

private func strings(_ root: [String: Any], _ path: String...) -> [String] {
    var current: Any = root
    for key in path {
        guard let dict = current as? [String: Any], let next = dict[key] else { return [] }
        current = next
    }
    return (current as? [Any])?.compactMap { $0 as? String } ?? []
}

private func intDict(_ root: [String: Any], _ path: String...) -> [String: Int] {
    var current: Any = root
    for key in path {
        guard let dict = current as? [String: Any], let next = dict[key] else { return [:] }
        current = next
    }
    guard let dict = current as? [String: Any] else { return [:] }
    return dict.reduce(into: [:]) { output, item in
        if let int = item.value as? Int {
            output[item.key] = int
        } else if let number = item.value as? NSNumber {
            output[item.key] = number.intValue
        }
    }
}

private func lastPath(_ value: String) -> String {
    URL(fileURLWithPath: value).lastPathComponent
}

private func color(for tone: Tone) -> Color {
    switch tone {
    case .good: Color(red: 0.10, green: 0.52, blue: 0.39)
    case .busy: Color(red: 0.10, green: 0.36, blue: 0.72)
    case .waiting: Color(red: 0.74, green: 0.42, blue: 0.09)
    case .blocked: Color(red: 0.72, green: 0.16, blue: 0.21)
    case .neutral: Color(red: 0.36, green: 0.36, blue: 0.42)
    }
}

private func soil(for tone: Tone) -> Color {
    switch tone {
    case .good: Color(red: 0.75, green: 0.86, blue: 0.52)
    case .busy: Color(red: 0.64, green: 0.79, blue: 0.95)
    case .waiting: Color(red: 0.90, green: 0.76, blue: 0.48)
    case .blocked: Color(red: 0.88, green: 0.57, blue: 0.54)
    case .neutral: Color(red: 0.78, green: 0.76, blue: 0.70)
    }
}
