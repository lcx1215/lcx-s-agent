import AppKit
import Foundation
import Observation
import SwiftUI

struct LCXAgentDepartment: Identifiable, Equatable {
    enum Tone: Equatable {
        case good
        case busy
        case waiting
        case blocked
        case neutral
    }

    let id: String
    let title: String
    let subtitle: String
    let status: String
    let detail: String
    let systemImage: String
    let tone: Tone
}

struct LCXAgentControlRoomSnapshot: Equatable {
    let checkedAt: String
    let repoLine: String
    let repoDirtyCount: Int
    let activeHeavy: Bool
    let activePidCounts: [String: Int]
    let selectedCleanAdapter: String
    let latestCandidateAdapter: String
    let promotionReady: Bool
    let failedCaseCount: Int
    let parseRecoveredCount: Int
    let autopilotOk: Bool
    let parsedOwnerCount: Int
    let structuralOwnerFailures: [String]
    let blockedClusters: [String]
    let blockedGates: [String]
    let fastestSafeNextAction: String
    let externalChannelStatus: String
    let externalChannelMissingProof: [String]
    let userVisibleObserved: Bool
    let skillOptStatus: String
    let skillOptMatchedSkillIds: [String]
    let skillOptNextIdleAction: String
    let blacktechMechanismCount: Int
    let blacktechRoutedCount: Int
    let blacktechRuntimeAuthorityCount: Int
    let blacktechPerfectIntegrationClaim: Bool
    let providerCouncilStatus: String
    let providerCouncilAction: String
    let providerCouncilHardBlocks: [String]
    let handoffPath: String
    let handoffGeneratedAt: String
    let handoffBoundary: String
    let sourceReadStatus: String
    let departments: [LCXAgentDepartment]

    static func load(stateDirectoryURL: URL = Self.defaultStateDirectoryURL()) -> LCXAgentControlRoomSnapshot {
        let autopilotURL = stateDirectoryURL.appendingPathComponent("lcx-governance-autopilot-latest.json")
        let digestURL = stateDirectoryURL.appendingPathComponent("lcx-evolution-promotion-digest-latest.json")
        let handoffURL = stateDirectoryURL.appendingPathComponent("lcx-context-recovery-handoff-latest.md")
        let autopilot = Self.readJSONObject(at: autopilotURL)
        let digest = Self.readJSONObject(at: digestURL)
        let handoff = (try? String(contentsOf: handoffURL, encoding: .utf8)) ?? ""
        return Self.build(autopilot: autopilot, digest: digest, handoff: handoff, handoffPath: handoffURL.path)
    }

    static func build(
        autopilot: [String: Any],
        digest: [String: Any],
        handoff: String,
        handoffPath: String) -> LCXAgentControlRoomSnapshot
    {
        let autopilotSummary = JSONPath.dictionary(autopilot, "summary")
        let digestAutopilotSummary = JSONPath.dictionary(digest, "autopilot", "summary")
        let summary = autopilotSummary.isEmpty ? digestAutopilotSummary : autopilotSummary
        let material = JSONPath.dictionary(digest, "material")
        let externalChannelBinding = JSONPath.dictionary(digest, "externalChannelBinding")
        let latestCandidate = JSONPath.dictionary(material, "latestCandidateEval")
        let repo = JSONPath.dictionary(digest, "repo")

        let checkedAt = JSONPath.string(digest, "checkedAt")
            ?? JSONPath.string(autopilot, "checkedAt")
            ?? "not available"
        let repoLine = JSONPath.string(repo, "statusShortBranch")
            ?? JSONPath.string(material, "repoBranch")
            ?? "repo state unavailable"
        let repoDirtyCount = JSONPath.int(repo, "dirtyCount")
            ?? JSONPath.int(material, "repoDirtyCount")
            ?? JSONPath.int(summary, "universeIndexDirtyFiles")
            ?? 0
        let activePidCounts = JSONPath.intDictionary(material, "activePidCounts")
        let activeHeavy = JSONPath.bool(material, "activeHeavy")
            ?? JSONPath.bool(summary, "activeTrainingOrEval")
            ?? false
        let selectedCleanAdapter = JSONPath.string(material, "selectedCleanAdapter")
            ?? JSONPath.string(externalChannelBinding, "selectedCleanAdapter")
            ?? JSONPath.string(summary, "activeNonIdleProgress", "selectedCleanAdapter")
            ?? "not selected"
        let latestCandidateAdapter = JSONPath.string(latestCandidate, "adapterPath")
            ?? "not available"
        let failedCaseCount = JSONPath.stringArray(latestCandidate, "failedCaseIds").count
        let parseRecoveredCount = JSONPath.stringArray(latestCandidate, "parseRecoveredCaseIds").count
        let promotionReady = JSONPath.bool(latestCandidate, "promotionReady") ?? false
        let structuralOwnerFailures = JSONPath.stringArray(summary, "structuralOwnerFailures")
        let blockedClusters = JSONPath.stringArray(summary, "blockedClusters")
        let blockedGates = JSONPath.stringArray(summary, "blockedGates")
        let externalChannelMissingProof = JSONPath.stringArray(material, "externalChannelMissingProof")
            .ifEmpty(JSONPath.stringArray(externalChannelBinding, "missingProof"))
        let hardBlocks = JSONPath.stringArray(material, "providerCouncilAccelerationHardBlocks")
        let handoffLines = Self.parseHandoffHeader(handoff)
        let snapshot = LCXAgentControlRoomSnapshot(
            checkedAt: checkedAt,
            repoLine: repoLine,
            repoDirtyCount: repoDirtyCount,
            activeHeavy: activeHeavy,
            activePidCounts: activePidCounts,
            selectedCleanAdapter: Self.displayAdapterName(selectedCleanAdapter),
            latestCandidateAdapter: Self.displayAdapterName(latestCandidateAdapter),
            promotionReady: promotionReady,
            failedCaseCount: failedCaseCount,
            parseRecoveredCount: parseRecoveredCount,
            autopilotOk: JSONPath.bool(digest, "autopilot", "ok") ?? JSONPath.bool(autopilot, "ok") ?? false,
            parsedOwnerCount: JSONPath.int(summary, "parsedOwners") ?? JSONPath.int(summary, "ownerCount") ?? 0,
            structuralOwnerFailures: structuralOwnerFailures,
            blockedClusters: blockedClusters,
            blockedGates: blockedGates,
            fastestSafeNextAction: JSONPath.string(summary, "fastestSafeNextAction")
                ?? JSONPath.string(material, "fastestSafeNextAction")
                ?? "refresh owner state",
            externalChannelStatus: JSONPath.string(material, "externalChannelBindingStatus")
                ?? JSONPath.string(externalChannelBinding, "status")
                ?? "unknown",
            externalChannelMissingProof: externalChannelMissingProof,
            userVisibleObserved: JSONPath.bool(externalChannelBinding, "userVisibleObserved") ?? false,
            skillOptStatus: JSONPath.string(material, "skillOptLiteStatus")
                ?? JSONPath.string(summary, "skillOptLiteStatus")
                ?? "unknown",
            skillOptMatchedSkillIds: JSONPath.stringArray(material, "skillOptLiteMatchedSkillIds"),
            skillOptNextIdleAction: JSONPath.string(material, "skillOptLiteNextIdleAction")
                ?? JSONPath.string(summary, "skillOptLiteNextIdleAction")
                ?? "none",
            blacktechMechanismCount: JSONPath.int(material, "externalUpgradeBlacktechMechanismCount")
                ?? JSONPath.int(summary, "externalUpgradeBlacktechMechanismCount")
                ?? 0,
            blacktechRoutedCount: JSONPath.int(material, "externalUpgradeBlacktechAutopilotRoutedCount")
                ?? JSONPath.int(summary, "externalUpgradeBlacktechAutopilotRoutedCount")
                ?? 0,
            blacktechRuntimeAuthorityCount: JSONPath.int(material, "externalUpgradeBlacktechRuntimeAuthorityGrantedCount")
                ?? JSONPath.int(summary, "externalUpgradeBlacktechRuntimeAuthorityGrantedCount")
                ?? 0,
            blacktechPerfectIntegrationClaim: JSONPath.bool(material, "externalUpgradePerfectIntegrationClaim")
                ?? JSONPath.bool(summary, "externalUpgradePerfectIntegrationClaim")
                ?? false,
            providerCouncilStatus: JSONPath.string(material, "providerCouncilAccelerationStatus")
                ?? JSONPath.string(summary, "providerCouncilAccelerationStatus")
                ?? "unknown",
            providerCouncilAction: JSONPath.string(material, "providerCouncilAccelerationAction")
                ?? JSONPath.string(summary, "providerCouncilAccelerationAction")
                ?? "unknown",
            providerCouncilHardBlocks: hardBlocks,
            handoffPath: handoffPath,
            handoffGeneratedAt: handoffLines["generatedAt"] ?? "not available",
            handoffBoundary: handoffLines["boundary"] ?? "not available",
            sourceReadStatus: autopilot.isEmpty && digest.isEmpty ? "owner snapshots missing" : "owner snapshots loaded",
            departments: [])
        return snapshot.withDepartments()
    }

    private func withDepartments() -> LCXAgentControlRoomSnapshot {
        let activeTotal = self.activePidCounts.values.reduce(0, +)
        let channelTone: LCXAgentDepartment.Tone = self.externalChannelStatus.contains("deferred") ? .waiting : .good
        let skillTone: LCXAgentDepartment.Tone = self.skillOptStatus.contains("pending") ? .waiting : .good
        let providerTone: LCXAgentDepartment.Tone = self.providerCouncilHardBlocks.isEmpty ? .good : .blocked
        let departments = [
            LCXAgentDepartment(
                id: "governance",
                title: "农场总管屋",
                subtitle: "Governance Farmhouse",
                status: self.autopilotOk ? "\(self.parsedOwnerCount) 个 owner 已巡检" : "owner 巡检异常",
                detail: self.structuralOwnerFailures.isEmpty
                    ? "像农场排班一样，把雷达、商业验收、mind model、flow graph、head-tail 统一调度。"
                    : "结构性失败: \(self.structuralOwnerFailures.joined(separator: ", "))",
                systemImage: "house.and.flag",
                tone: self.structuralOwnerFailures.isEmpty ? .good : .blocked),
            LCXAgentDepartment(
                id: "brain",
                title: "大脑温室",
                subtitle: "Qwen / MiniMax / MLX Greenhouse",
                status: self.activeHeavy ? "\(activeTotal) 个重任务在跑" : "空闲可接下一步",
                detail: "clean 种苗: \(self.selectedCleanAdapter); 候选作物: \(self.latestCandidateAdapter); 返修苗 \(self.parseRecoveredCount)。",
                systemImage: "leaf",
                tone: self.activeHeavy ? .busy : .good),
            LCXAgentDepartment(
                id: "skillopt",
                title: "技能工坊",
                subtitle: "SkillOpt Tool Shed",
                status: self.skillOptStatus,
                detail: self.skillOptMatchedSkillIds.isEmpty
                    ? "等待错题、用户反馈或 owner 候选。"
                    : "把错题锻造成工具: \(self.skillOptMatchedSkillIds.joined(separator: ", ")); 下一步: \(self.skillOptNextIdleAction)。",
                systemImage: "hammer",
                tone: skillTone),
            LCXAgentDepartment(
                id: "external-channel",
                title: "通用外部消息通道",
                subtitle: "Real External Message Shipping Dock",
                status: self.externalChannelStatus,
                detail: self.userVisibleObserved
                    ? "已有真实 inbound/outbound 证据。"
                    : "还缺 \(self.externalChannelMissingProof.count) 张出港单，不能冒充已观测。",
                systemImage: "sailboat",
                tone: channelTone),
            LCXAgentDepartment(
                id: "module-learning",
                title: "知识谷仓",
                subtitle: "Source / Receipt / Absorption Silo",
                status: self.blockedClusters.contains("module_learning_absorption_cluster") ? "吸收证据未闭环" : "模块证据链可用",
                detail: "收进谷仓的 receipt 还不是种进权重；需要 retrieval/apply、review、eval 或 promotion 证明。",
                systemImage: "building.columns",
                tone: self.blockedClusters.contains("module_learning_absorption_cluster") ? .waiting : .good),
            LCXAgentDepartment(
                id: "provider-council",
                title: "三家议事鸡舍",
                subtitle: "Kimi / MiniMax / DeepSeek Coop",
                status: "\(self.providerCouncilStatus) / \(self.providerCouncilAction)",
                detail: self.providerCouncilHardBlocks.isEmpty
                    ? "门闸干净时可写入一次高 token 议会结果。"
                    : "硬阻塞: \(self.providerCouncilHardBlocks.joined(separator: ", "))",
                systemImage: "person.3",
                tone: providerTone),
            LCXAgentDepartment(
                id: "blacktech",
                title: "黑科技发明棚",
                subtitle: "External Upgrade Workshop",
                status: "\(self.blacktechRoutedCount)/\(self.blacktechMechanismCount) 已接入 owner 路由",
                detail: "新农具只进 owner 路由，不直接拿 runtime 权限: \(self.blacktechRuntimeAuthorityCount); perfectIntegrationClaim=\(self.blacktechPerfectIntegrationClaim)。",
                systemImage: "wrench.and.screwdriver",
                tone: self.blacktechRuntimeAuthorityCount == 0 ? .good : .blocked),
            LCXAgentDepartment(
                id: "safety",
                title: "安全栅栏",
                subtitle: "External Channel / Provider / Protected Fence",
                status: self.blockedGates.isEmpty ? "边界清楚" : "\(self.blockedGates.count) 个 gate 阻塞",
                detail: self.fastestSafeNextAction,
                systemImage: "lock.shield",
                tone: self.blockedGates.isEmpty ? .good : .waiting),
        ]
        return LCXAgentControlRoomSnapshot(
            checkedAt: self.checkedAt,
            repoLine: self.repoLine,
            repoDirtyCount: self.repoDirtyCount,
            activeHeavy: self.activeHeavy,
            activePidCounts: self.activePidCounts,
            selectedCleanAdapter: self.selectedCleanAdapter,
            latestCandidateAdapter: self.latestCandidateAdapter,
            promotionReady: self.promotionReady,
            failedCaseCount: self.failedCaseCount,
            parseRecoveredCount: self.parseRecoveredCount,
            autopilotOk: self.autopilotOk,
            parsedOwnerCount: self.parsedOwnerCount,
            structuralOwnerFailures: self.structuralOwnerFailures,
            blockedClusters: self.blockedClusters,
            blockedGates: self.blockedGates,
            fastestSafeNextAction: self.fastestSafeNextAction,
            externalChannelStatus: self.externalChannelStatus,
            externalChannelMissingProof: self.externalChannelMissingProof,
            userVisibleObserved: self.userVisibleObserved,
            skillOptStatus: self.skillOptStatus,
            skillOptMatchedSkillIds: self.skillOptMatchedSkillIds,
            skillOptNextIdleAction: self.skillOptNextIdleAction,
            blacktechMechanismCount: self.blacktechMechanismCount,
            blacktechRoutedCount: self.blacktechRoutedCount,
            blacktechRuntimeAuthorityCount: self.blacktechRuntimeAuthorityCount,
            blacktechPerfectIntegrationClaim: self.blacktechPerfectIntegrationClaim,
            providerCouncilStatus: self.providerCouncilStatus,
            providerCouncilAction: self.providerCouncilAction,
            providerCouncilHardBlocks: self.providerCouncilHardBlocks,
            handoffPath: self.handoffPath,
            handoffGeneratedAt: self.handoffGeneratedAt,
            handoffBoundary: self.handoffBoundary,
            sourceReadStatus: self.sourceReadStatus,
            departments: departments)
    }

    private static func defaultStateDirectoryURL() -> URL {
        OpenClawConfigFile.stateDirURL()
            .appendingPathComponent("workspace", isDirectory: true)
            .appendingPathComponent("state", isDirectory: true)
    }

    private static func readJSONObject(at url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return root
    }

    private static func parseHandoffHeader(_ handoff: String) -> [String: String] {
        var parsed: [String: String] = [:]
        for line in handoff.split(separator: "\n", omittingEmptySubsequences: false) {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            if ["generatedAt", "boundary", "repo", "branch", "dirtyCount"].contains(key) {
                parsed[key] = value
            }
        }
        return parsed
    }

    private static func displayAdapterName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "not available" }
        return URL(fileURLWithPath: trimmed).lastPathComponent
    }
}

@MainActor
@Observable
final class LCXAgentControlRoomStore {
    var snapshot: LCXAgentControlRoomSnapshot

    init(snapshot: LCXAgentControlRoomSnapshot = LCXAgentControlRoomSnapshot.load()) {
        self.snapshot = snapshot
    }

    func refresh() {
        self.snapshot = LCXAgentControlRoomSnapshot.load()
    }
}

@MainActor
enum LCXAgentControlRoomWindow {
    private static var window: NSWindow?

    static func open() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let store = LCXAgentControlRoomStore()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "LCX Agent Control Room"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 860, height: 620)
        window.contentView = NSHostingView(rootView: LCXAgentControlRoomView(store: store))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }
}

private enum JSONPath {
    static func dictionary(_ root: [String: Any], _ path: String...) -> [String: Any] {
        var current: Any = root
        for key in path {
            guard let dict = current as? [String: Any], let next = dict[key] else { return [:] }
            current = next
        }
        return current as? [String: Any] ?? [:]
    }

    static func string(_ root: [String: Any], _ path: String...) -> String? {
        let value = self.value(root, path)
        if let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    static func int(_ root: [String: Any], _ path: String...) -> Int? {
        let value = self.value(root, path)
        if let int = value as? Int { return int }
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return nil
    }

    static func bool(_ root: [String: Any], _ path: String...) -> Bool? {
        let value = self.value(root, path)
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber { return number.boolValue }
        if let string = value as? String {
            switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "true", "yes", "1": return true
            case "false", "no", "0": return false
            default: return nil
            }
        }
        return nil
    }

    static func stringArray(_ root: [String: Any], _ path: String...) -> [String] {
        guard let values = self.value(root, path) as? [Any] else { return [] }
        return values.compactMap { value in
            if let string = value as? String {
                let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            if let number = value as? NSNumber { return number.stringValue }
            return nil
        }
    }

    static func intDictionary(_ root: [String: Any], _ path: String...) -> [String: Int] {
        guard let dict = self.value(root, path) as? [String: Any] else { return [:] }
        return dict.reduce(into: [:]) { partial, element in
            if let value = element.value as? Int {
                partial[element.key] = value
            } else if let number = element.value as? NSNumber {
                partial[element.key] = number.intValue
            }
        }
    }

    private static func value(_ root: [String: Any], _ path: [String]) -> Any? {
        var current: Any = root
        for key in path {
            guard let dict = current as? [String: Any], let next = dict[key] else { return nil }
            current = next
        }
        return current
    }
}

private extension Array where Element == String {
    func ifEmpty(_ fallback: [String]) -> [String] {
        self.isEmpty ? fallback : self
    }
}
