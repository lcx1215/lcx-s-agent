import Foundation
import OSLog

struct LobsterWorkfacePanelArtifacts {
    let workspaceURL: URL
    let htmlURL: URL
    let sourceArtifactURL: URL?
    let emptyState: Bool
    let statusLine: String
}

private struct LobsterWorkfacePanelAnchorState {
    let path: String
    let present: Bool
}

private struct LobsterWorkfacePanelRender {
    let html: String
    let sourceArtifactURL: URL?
    let emptyState: Bool
    let statusLine: String
}

private struct ParsedLobsterWorkfacePanelArtifact {
    let dateKey: String
    let learningItems: String
    let correctionNotes: String
    let watchtowerSignals: String
    let codexEscalations: String
    let activeSurfaceLanes: String
    let portfolioScorecard: String
    let totalTokens: String
    let estimatedCost: String
    let strongestDomain: String
    let weakestDomain: String
    let hallucinationWatch: String
    let learningKeep: String
    let learningDiscard: String
    let learningReplay: String
    let learningNextEval: String
    let dashboardSnapshotLines: [String]
    let lanePanelLines: [String]
    let yesterdayLearnedLines: [String]
    let yesterdayCorrectedLines: [String]
    let yesterdayWatchtowerLines: [String]
    let readingGuideLines: [String]
}

private struct ParsedCurrentResearchLine {
    let currentFocus: String
    let topDecision: String
    let currentSessionSummary: String
    let freshness: String
    let primaryAnchor: String
    let nextStep: String
    let guardrail: String
    let recallOrder: String
    let continuousImprovementLines: [String]
    let memoryBudgetLines: [String]
    let verifiedAnchorLines: [String]
}

enum LobsterWorkfacePanel {
    static let sessionKey = "lobster-workface-panel"

    private static let logger = Logger(subsystem: "ai.openclaw", category: "lobster.panel")
    private static let protectedAnchors = [
        "memory/current-research-line.md",
        "memory/unified-risk-view.md",
        "MEMORY.md",
    ]

    @MainActor
    static func openInCanvas() throws -> LobsterWorkfacePanelArtifacts {
        let canvasDirectory = try CanvasManager.shared.show(sessionKey: self.sessionKey, path: "/")
        let artifacts = try self.prepareArtifacts(outputDirectoryURL: URL(fileURLWithPath: canvasDirectory, isDirectory: true))
        _ = try CanvasManager.shared.show(sessionKey: self.sessionKey, path: "/")
        return artifacts
    }

    static func prepareArtifacts(
        workspaceURL explicitWorkspaceURL: URL? = nil,
        outputDirectoryURL explicitOutputDirectoryURL: URL? = nil,
        generatedAt: Date = Date()) throws -> LobsterWorkfacePanelArtifacts
    {
        let workspaceURL = explicitWorkspaceURL ?? self.resolveWorkspaceURL()
        let render = self.renderPanel(workspaceURL: workspaceURL, generatedAt: generatedAt)
        let outputDir = explicitOutputDirectoryURL ?? self.outputDirectoryURL()
        try FileManager().createDirectory(at: outputDir, withIntermediateDirectories: true)
        let htmlURL = outputDir.appendingPathComponent("index.html", isDirectory: false)
        try render.html.write(to: htmlURL, atomically: true, encoding: .utf8)
        return LobsterWorkfacePanelArtifacts(
            workspaceURL: workspaceURL,
            htmlURL: htmlURL,
            sourceArtifactURL: render.sourceArtifactURL,
            emptyState: render.emptyState,
            statusLine: render.statusLine)
    }

    static func resolveWorkspaceURL() -> URL {
        let rawWorkspace = OpenClawConfigFile.agentWorkspace()?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !rawWorkspace.isEmpty {
            return URL(fileURLWithPath: NSString(string: rawWorkspace).expandingTildeInPath, isDirectory: true)
        }
        return OpenClawConfigFile.defaultWorkspaceURL()
    }

    static func latestArtifactURL(in workspaceURL: URL) throws -> URL? {
        let memoryDir = workspaceURL.appendingPathComponent("memory", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager().fileExists(atPath: memoryDir.path, isDirectory: &isDirectory), isDirectory.boolValue
        else {
            return nil
        }

        return try FileManager()
            .contentsOfDirectory(
                at: memoryDir,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])
            .filter { self.isWorkfaceFilename($0.lastPathComponent) }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
            .first
    }

    private static func renderPanel(workspaceURL: URL, generatedAt: Date) -> LobsterWorkfacePanelRender {
        let generatedAtString = ISO8601DateFormatter().string(from: generatedAt)
        let anchorStates = self.protectedAnchors.map { path in
            LobsterWorkfacePanelAnchorState(
                path: path,
                present: FileManager().fileExists(atPath: workspaceURL.appendingPathComponent(path).path))
        }
        do {
            guard let artifactURL = try self.latestArtifactURL(in: workspaceURL) else {
                let currentResearchLineURL = workspaceURL.appendingPathComponent("memory/current-research-line.md")
                if let parsedResearchLine = self.parseCurrentResearchLineIfPresent(at: currentResearchLineURL) {
                    let statusLine = "No latest lobster-workface artifact is available yet; showing current research line bootstrap."
                    return LobsterWorkfacePanelRender(
                        html: self.buildResearchBootstrapHTML(
                            title: "Lobster Workface Panel",
                            generatedAt: generatedAtString,
                            statusLine: statusLine,
                            workspaceLabel: self.displayPath(workspaceURL),
                            sourceLabel: self.relativeLabel(for: currentResearchLineURL, workspaceURL: workspaceURL),
                            parsed: parsedResearchLine,
                            anchorStates: anchorStates),
                        sourceArtifactURL: currentResearchLineURL,
                        emptyState: true,
                        statusLine: statusLine)
                }
                let statusLine = "No latest lobster-workface artifact is available yet."
                return LobsterWorkfacePanelRender(
                    html: self.buildEmptyStateHTML(
                        title: "Lobster Workface Panel",
                        generatedAt: generatedAtString,
                        statusLine: statusLine,
                        detailLines: [
                            "Workspace: \(self.displayPath(workspaceURL))",
                            "Expected artifact: memory/YYYY-MM-DD-lobster-workface.md",
                        ],
                        anchorStates: anchorStates),
                    sourceArtifactURL: nil,
                    emptyState: true,
                    statusLine: statusLine)
            }

            let content = try String(contentsOf: artifactURL, encoding: .utf8)
            guard let parsed = self.parseArtifact(content) else {
                let statusLine = "Latest lobster-workface artifact format is unrecognized."
                return LobsterWorkfacePanelRender(
                    html: self.buildEmptyStateHTML(
                        title: "Lobster Workface Panel",
                        generatedAt: generatedAtString,
                        statusLine: statusLine,
                        detailLines: [
                            "Artifact: \(self.relativeLabel(for: artifactURL, workspaceURL: workspaceURL))",
                            "The file exists, but it does not match the expected Lobster workface format.",
                        ],
                        anchorStates: anchorStates),
                    sourceArtifactURL: artifactURL,
                    emptyState: true,
                    statusLine: statusLine)
            }

            let statusLine = "Latest lobster-workface panel refreshed from current workspace state."
            return LobsterWorkfacePanelRender(
                html: self.buildWorkfaceHTML(
                    title: "Lobster Workface Panel",
                    generatedAt: generatedAtString,
                    sourceLabel: self.relativeLabel(for: artifactURL, workspaceURL: workspaceURL),
                    workspaceLabel: self.displayPath(workspaceURL),
                    parsed: parsed,
                    anchorStates: anchorStates),
                sourceArtifactURL: artifactURL,
                emptyState: false,
                statusLine: statusLine)
        } catch {
            let statusLine = "Workspace memory state unavailable."
            self.logger.warning("lobster panel fallback: \(error.localizedDescription, privacy: .public)")
            return LobsterWorkfacePanelRender(
                html: self.buildEmptyStateHTML(
                    title: "Lobster Workface Panel",
                    generatedAt: generatedAtString,
                    statusLine: statusLine,
                    detailLines: [
                        "Workspace: \(self.displayPath(workspaceURL))",
                        "Read error: \(error.localizedDescription)",
                    ],
                    anchorStates: anchorStates),
                sourceArtifactURL: nil,
                emptyState: true,
                statusLine: statusLine)
        }
    }

    private static func outputDirectoryURL() -> URL {
        OpenClawConfigFile.stateDirURL().appendingPathComponent("lobster-workface-panel", isDirectory: true)
    }

    private static func isWorkfaceFilename(_ filename: String) -> Bool {
        filename.range(of: #"^\d{4}-\d{2}-\d{2}-lobster-workface\.md$"#, options: .regularExpression) != nil
    }

    private static func parseArtifact(_ content: String) -> ParsedLobsterWorkfacePanelArtifact? {
        let normalized = content.replacingOccurrences(of: "\r\n", with: "\n")
        guard let dateKey = normalized
            .split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { $0.hasPrefix("# Lobster Workface: ") })?
            .replacingOccurrences(of: "# Lobster Workface: ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !dateKey.isEmpty
        else {
            return nil
        }

        let validationLines = self.extractSectionLines(from: normalized, heading: "Validation Radar")
        let learnedLines = self.extractSectionLines(from: normalized, heading: "Yesterday Learned")
        return ParsedLobsterWorkfacePanelArtifact(
            dateKey: dateKey,
            learningItems: self.extractTopLevelValue(from: normalized, label: "Learning Items") ?? "0",
            correctionNotes: self.extractTopLevelValue(from: normalized, label: "Correction Notes") ?? "0",
            watchtowerSignals: self.extractTopLevelValue(from: normalized, label: "Watchtower Signals") ?? "0",
            codexEscalations: self.extractTopLevelValue(from: normalized, label: "Codex Escalations") ?? "0",
            activeSurfaceLanes: self.extractTopLevelValue(from: normalized, label: "Active Surface Lanes")
                ?? self.extractSectionValue(from: self.extractSectionLines(from: normalized, heading: "Feishu Lane Panel"), label: "Active Lanes")
                ?? "0",
            portfolioScorecard: self.extractTopLevelValue(from: normalized, label: "Portfolio Scorecard") ?? "not scored",
            totalTokens: self.extractTopLevelValue(from: normalized, label: "Total Tokens") ?? "0",
            estimatedCost: self.extractTopLevelValue(from: normalized, label: "Estimated Cost") ?? "$0.0000",
            strongestDomain: self.extractSectionValue(from: validationLines, label: "Strongest Domain") ?? "Not recorded",
            weakestDomain: self.extractSectionValue(from: validationLines, label: "Weakest Domain") ?? "Not recorded",
            hallucinationWatch: self.extractSectionValue(from: validationLines, label: "Hallucination Watch") ?? "Not recorded",
            learningKeep: self.extractSectionValue(from: learnedLines, label: "keep") ?? "Not recorded yet",
            learningDiscard: self.extractSectionValue(from: learnedLines, label: "discard") ?? "Not recorded yet",
            learningReplay: self.extractSectionValue(from: learnedLines, label: "replay") ?? "Not recorded yet",
            learningNextEval: self.extractSectionValue(from: learnedLines, label: "next eval") ?? "Not recorded yet",
            dashboardSnapshotLines: self.extractSectionLines(from: normalized, heading: "Dashboard Snapshot"),
            lanePanelLines: self.extractSectionLines(from: normalized, heading: "Feishu Lane Panel"),
            yesterdayLearnedLines: learnedLines,
            yesterdayCorrectedLines: self.extractSectionLines(from: normalized, heading: "Yesterday Corrected"),
            yesterdayWatchtowerLines: self.extractSectionLines(from: normalized, heading: "Yesterday Watchtower"),
            readingGuideLines: self.extractSectionLines(from: normalized, heading: "Reading Guide"))
    }

    private static func parseCurrentResearchLineIfPresent(at url: URL) -> ParsedCurrentResearchLine? {
        guard FileManager().fileExists(atPath: url.path),
              let content = try? String(contentsOf: url, encoding: .utf8)
        else {
            return nil
        }
        return self.parseCurrentResearchLine(content)
    }

    private static func parseCurrentResearchLine(_ content: String) -> ParsedCurrentResearchLine? {
        let normalized = content.replacingOccurrences(of: "\r\n", with: "\n")
        guard normalized.hasPrefix("# Current Research Line") else {
            return nil
        }
        let currentFocus = self.extractPlainKeyValue(from: normalized, key: "current_focus") ?? "not recorded"
        let topDecision = self.extractPlainKeyValue(from: normalized, key: "top_decision") ?? "not recorded"
        let currentSessionSummary =
            self.extractPlainKeyValue(from: normalized, key: "current_session_summary") ?? "not recorded"
        let freshness = self.extractPlainKeyValue(from: normalized, key: "freshness") ?? "unknown"
        let primaryAnchor = self.extractPlainKeyValue(from: normalized, key: "primary_anchor") ?? "not recorded"
        let nextStep = self.extractPlainKeyValue(from: normalized, key: "next_step") ?? "not recorded"
        let guardrail = self.extractPlainKeyValue(from: normalized, key: "guardrail") ?? "not recorded"
        let recallOrder = self.extractPlainKeyValue(from: normalized, key: "recall_order") ?? "not recorded"
        return ParsedCurrentResearchLine(
            currentFocus: currentFocus,
            topDecision: topDecision,
            currentSessionSummary: currentSessionSummary,
            freshness: freshness,
            primaryAnchor: primaryAnchor,
            nextStep: nextStep,
            guardrail: guardrail,
            recallOrder: recallOrder,
            continuousImprovementLines: self.extractSectionLines(from: normalized, heading: "Continuous Improvement"),
            memoryBudgetLines: self.extractSectionLines(from: normalized, heading: "Memory Budget"),
            verifiedAnchorLines: Array(self.extractSectionLines(from: normalized, heading: "Verified Anchors").prefix(8)))
    }

    private static func extractTopLevelValue(from content: String, label: String) -> String? {
        let prefix = "- **\(label)**: "
        return content
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .first(where: { $0.hasPrefix(prefix) })?
            .dropFirst(prefix.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractPlainKeyValue(from content: String, key: String) -> String? {
        let prefix = "\(key): "
        return content
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .first(where: { $0.hasPrefix(prefix) })?
            .dropFirst(prefix.count)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractSectionLines(from content: String, heading: String) -> [String] {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let startIndex = lines.firstIndex(of: "## \(heading)") else { return [] }
        var collected: [String] = []
        for line in lines[(startIndex + 1)...] {
            if line.hasPrefix("## ") {
                break
            }
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                collected.append(trimmed)
            }
        }
        return collected
    }

    private static func extractSectionValue(from lines: [String], label: String) -> String? {
        let normalizedLabel = label.lowercased()
        for line in lines {
            let normalized = self.normalizeListLine(line)
            let parts = normalized.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            if parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalizedLabel {
                return parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    private static func normalizeListLine(_ line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("- ") else { return trimmed }
        return String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func buildWorkfaceHTML(
        title: String,
        generatedAt: String,
        sourceLabel: String,
        workspaceLabel: String,
        parsed: ParsedLobsterWorkfacePanelArtifact,
        anchorStates: [LobsterWorkfacePanelAnchorState]) -> String
    {
        let presentAnchors = anchorStates.filter(\.present).count
        let missingAnchors = anchorStates.count - presentAnchors
        return """
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>\(self.escapeHTML(title))</title>
            <style>
              :root {
                color-scheme: light;
                --bg: #f6f1e7;
                --panel: rgba(255, 252, 247, 0.96);
                --panel-border: rgba(76, 61, 46, 0.12);
                --ink: #221a14;
                --muted: #6d5d51;
                --accent: #165d52;
                --accent-soft: rgba(22, 93, 82, 0.12);
                --warn-soft: rgba(143, 77, 25, 0.12);
                --shadow: 0 22px 48px rgba(48, 32, 18, 0.12);
                --radius: 24px;
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Avenir Next", "Segoe UI", sans-serif;
                background:
                  radial-gradient(circle at top left, rgba(22, 93, 82, 0.12), transparent 34%),
                  radial-gradient(circle at top right, rgba(143, 77, 25, 0.12), transparent 32%),
                  linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
                color: var(--ink);
              }
              .frame { max-width: 1240px; margin: 0 auto; padding: 28px; }
              .hero, .panel, .metric-card, .carryover-card {
                background: var(--panel);
                border: 1px solid var(--panel-border);
                border-radius: var(--radius);
                box-shadow: var(--shadow);
              }
              .hero { padding: 28px; display: grid; gap: 12px; }
              .eyebrow {
                text-transform: uppercase;
                letter-spacing: 0.18em;
                font-size: 12px;
                color: var(--muted);
              }
              h1 { margin: 0; font-size: clamp(32px, 5vw, 54px); line-height: 1; }
              .hero-copy { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
              .hero-meta, .metric-grid, .section-grid, .carryover-grid {
                display: grid;
                gap: 14px;
                margin-top: 18px;
              }
              .hero-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 6px;
              }
              .hero-meta {
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              }
              .action-link {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 12px 16px;
                border-radius: 999px;
                border: 1px solid var(--panel-border);
                background: rgba(255, 255, 255, 0.78);
                color: var(--ink);
                text-decoration: none;
                font-size: 13px;
                font-weight: 600;
              }
              .chip, .metric-card, .carryover-card, .panel-line {
                border-radius: 18px;
              }
              .chip {
                padding: 12px 14px;
                border: 1px solid var(--panel-border);
                background: rgba(255, 255, 255, 0.7);
                font-size: 13px;
              }
              .metric-grid {
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
              }
              .metric-card {
                padding: 16px;
                display: grid;
                gap: 8px;
              }
              .metric-card.accent {
                background: linear-gradient(180deg, var(--accent-soft), rgba(255, 252, 247, 0.96));
              }
              .metric-card.warn {
                background: linear-gradient(180deg, var(--warn-soft), rgba(255, 252, 247, 0.96));
              }
              .metric-label, .carryover-label {
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: var(--muted);
              }
              .metric-value {
                font-size: clamp(24px, 4vw, 36px);
                line-height: 1;
              }
              .section-grid {
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              }
              .panel { padding: 22px; }
              .panel h2 { margin: 0 0 14px; font-size: 18px; }
              .panel-list {
                list-style: none;
                padding: 0;
                margin: 0;
                display: grid;
                gap: 10px;
              }
              .panel-line {
                padding: 12px 14px;
                background: rgba(17, 24, 39, 0.04);
                line-height: 1.45;
                font-size: 14px;
              }
              .panel-line.muted {
                color: var(--muted);
                background: rgba(17, 24, 39, 0.03);
              }
              .carryover-grid {
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              }
              .carryover-card {
                padding: 16px;
                background: linear-gradient(180deg, var(--accent-soft), rgba(255, 252, 247, 0.96));
              }
              .carryover-value {
                display: block;
                margin-top: 8px;
                font-size: 15px;
                line-height: 1.45;
              }
              .footer {
                margin-top: 18px;
                text-align: right;
                color: var(--muted);
                font-size: 13px;
              }
            </style>
          </head>
          <body>
            <main class="frame">
              <section class="hero">
                <div class="eyebrow">Lobster Panel</div>
                <h1>\(self.escapeHTML(title))</h1>
                <p class="hero-copy">
                  Stable in-app workface panel generated from \(self.escapeHTML(sourceLabel)). This stays bounded to Lobster's daily research artifact instead of pretending to be a general app builder.
                </p>
                <div class="hero-actions">
                  <a class="action-link" href="openclaw://lobster-panel">Refresh Panel</a>
                </div>
                <div class="hero-meta">
                  <div class="chip">Date \(self.escapeHTML(parsed.dateKey))</div>
                  <div class="chip">Workspace \(self.escapeHTML(workspaceLabel))</div>
                  <div class="chip">Portfolio \(self.escapeHTML(parsed.portfolioScorecard))</div>
                  <div class="chip">Protected anchors \(presentAnchors) present / \(missingAnchors) missing</div>
                  <div class="chip">Generated \(self.escapeHTML(generatedAt))</div>
                </div>
              </section>

              <section class="metric-grid">
                \(self.renderMetricCard(label: "Learning Items", value: parsed.learningItems, tone: "accent"))
                \(self.renderMetricCard(label: "Corrections", value: parsed.correctionNotes, tone: "accent"))
                \(self.renderMetricCard(label: "Watchtower", value: parsed.watchtowerSignals, tone: "accent"))
                \(self.renderMetricCard(label: "Codex Escalations", value: parsed.codexEscalations, tone: "warn"))
                \(self.renderMetricCard(label: "Tokens", value: parsed.totalTokens, tone: "accent"))
                \(self.renderMetricCard(label: "Estimated Cost", value: parsed.estimatedCost, tone: "warn"))
              </section>

              <section class="panel" style="margin-top: 20px;">
                <h2>Carryover Cue</h2>
                <div class="carryover-grid">
                  \(self.renderCarryoverCard(label: "Retain", value: parsed.learningKeep))
                  \(self.renderCarryoverCard(label: "Discard", value: parsed.learningDiscard))
                  \(self.renderCarryoverCard(label: "Replay", value: parsed.learningReplay))
                  \(self.renderCarryoverCard(label: "Next Eval", value: parsed.learningNextEval))
                </div>
              </section>

              <section class="section-grid" style="margin-top: 20px;">
                \(self.renderListPanel(title: "Validation Posture", lines: [
                    "Strongest Domain: \(parsed.strongestDomain)",
                    "Weakest Domain: \(parsed.weakestDomain)",
                    "Hallucination Watch: \(parsed.hallucinationWatch)",
                ]))
                \(self.renderListPanel(title: "Protected Anchors", lines: anchorStates.map {
                    "\($0.present ? "present" : "missing"): \($0.path)"
                }))
                \(self.renderListPanel(title: "Dashboard Snapshot", lines: parsed.dashboardSnapshotLines))
                \(self.renderListPanel(title: "Feishu Lane Panel", lines: parsed.lanePanelLines))
                \(self.renderListPanel(title: "Yesterday Learned", lines: parsed.yesterdayLearnedLines))
                \(self.renderListPanel(title: "Yesterday Corrected", lines: parsed.yesterdayCorrectedLines))
                \(self.renderListPanel(title: "Yesterday Watchtower", lines: parsed.yesterdayWatchtowerLines))
                \(self.renderListPanel(title: "Reading Guide", lines: parsed.readingGuideLines))
              </section>

              <div class="footer">Reopen this panel any time to rebuild it from the newest workface artifact in the configured workspace.</div>
            </main>
          </body>
        </html>
        """
    }

    private static func buildResearchBootstrapHTML(
        title: String,
        generatedAt: String,
        statusLine: String,
        workspaceLabel: String,
        sourceLabel: String,
        parsed: ParsedCurrentResearchLine,
        anchorStates: [LobsterWorkfacePanelAnchorState]) -> String
    {
        let presentAnchors = anchorStates.filter(\.present).count
        let missingAnchors = anchorStates.count - presentAnchors
        return """
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>\(self.escapeHTML(title))</title>
            <style>
              :root {
                color-scheme: light;
                --bg: #f6f0e6;
                --panel: rgba(255, 252, 247, 0.96);
                --panel-border: rgba(74, 58, 44, 0.12);
                --ink: #231a15;
                --muted: #6c5e53;
                --accent: #8f4d19;
                --accent-soft: rgba(143, 77, 25, 0.12);
                --shadow: 0 22px 44px rgba(48, 32, 18, 0.12);
                --radius: 24px;
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Avenir Next", "Segoe UI", sans-serif;
                color: var(--ink);
                background:
                  radial-gradient(circle at top left, rgba(143, 77, 25, 0.14), transparent 34%),
                  linear-gradient(180deg, #faf5ec 0%, var(--bg) 100%);
              }
              .frame { max-width: 1240px; margin: 0 auto; padding: 28px; }
              .hero, .panel, .metric-card {
                background: var(--panel);
                border: 1px solid var(--panel-border);
                border-radius: var(--radius);
                box-shadow: var(--shadow);
              }
              .hero { padding: 30px; display: grid; gap: 14px; }
              .eyebrow {
                text-transform: uppercase;
                letter-spacing: 0.18em;
                font-size: 12px;
                color: var(--muted);
              }
              h1 { margin: 0; font-size: clamp(32px, 5vw, 52px); line-height: 1; }
              .hero-copy { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
              .status-pill {
                display: inline-flex;
                width: fit-content;
                align-items: center;
                padding: 10px 14px;
                border-radius: 999px;
                background: var(--accent-soft);
                color: var(--accent);
                border: 1px solid rgba(143, 77, 25, 0.16);
                font-weight: 600;
              }
              .hero-actions, .metric-grid, .section-grid {
                display: grid;
                gap: 14px;
                margin-top: 18px;
              }
              .hero-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 6px;
              }
              .action-link {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 12px 16px;
                border-radius: 999px;
                border: 1px solid var(--panel-border);
                background: rgba(255, 255, 255, 0.78);
                color: var(--ink);
                text-decoration: none;
                font-size: 13px;
                font-weight: 600;
              }
              .metric-grid {
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              }
              .metric-card {
                padding: 16px;
                display: grid;
                gap: 8px;
                background: linear-gradient(180deg, var(--accent-soft), rgba(255, 252, 247, 0.96));
              }
              .metric-label {
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: var(--muted);
              }
              .metric-value {
                font-size: 20px;
                line-height: 1.3;
              }
              .section-grid {
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              }
              .panel { padding: 22px; }
              .panel h2 { margin: 0 0 14px; font-size: 18px; }
              .panel-list {
                list-style: none;
                padding: 0;
                margin: 0;
                display: grid;
                gap: 10px;
              }
              .panel-line {
                padding: 12px 14px;
                border-radius: 16px;
                background: rgba(17, 24, 39, 0.04);
                font-size: 14px;
                line-height: 1.45;
              }
              .footer {
                margin-top: 18px;
                text-align: right;
                color: var(--muted);
                font-size: 13px;
              }
            </style>
          </head>
          <body>
            <main class="frame">
              <section class="hero">
                <div class="eyebrow">Lobster Panel Bootstrap</div>
                <h1>\(self.escapeHTML(title))</h1>
                <div class="status-pill">\(self.escapeHTML(statusLine))</div>
                <p class="hero-copy">
                  No daily workface artifact is available yet, so this panel is bootstrapping from \(self.escapeHTML(sourceLabel)) instead of leaving you with an empty shell.
                </p>
                <div class="hero-actions">
                  <a class="action-link" href="openclaw://lobster-panel">Refresh Panel</a>
                </div>
                <p class="hero-copy">Workspace: \(self.escapeHTML(workspaceLabel))</p>
              </section>

              <section class="metric-grid">
                \(self.renderMetricCard(label: "Current Focus", value: parsed.currentFocus, tone: "accent"))
                \(self.renderMetricCard(label: "Freshness", value: parsed.freshness, tone: "accent"))
                \(self.renderMetricCard(label: "Primary Anchor", value: parsed.primaryAnchor, tone: "accent"))
                \(self.renderMetricCard(label: "Protected Anchors", value: "\(presentAnchors) present / \(missingAnchors) missing", tone: "accent"))
              </section>

              <section class="section-grid" style="margin-top: 20px;">
                \(self.renderListPanel(title: "Top Decision", lines: [parsed.topDecision]))
                \(self.renderListPanel(title: "Current Session Summary", lines: [parsed.currentSessionSummary]))
                \(self.renderListPanel(title: "Next Step", lines: [parsed.nextStep]))
                \(self.renderListPanel(title: "Guardrail", lines: [parsed.guardrail]))
                \(self.renderListPanel(title: "Continuous Improvement", lines: parsed.continuousImprovementLines))
                \(self.renderListPanel(title: "Memory Budget", lines: parsed.memoryBudgetLines))
                \(self.renderListPanel(title: "Recall Order", lines: [parsed.recallOrder]))
                \(self.renderListPanel(title: "Verified Anchors Snapshot", lines: parsed.verifiedAnchorLines))
                \(self.renderListPanel(title: "Protected Anchor Status", lines: anchorStates.map {
                    "\($0.present ? "present" : "missing"): \($0.path)"
                }))
              </section>

              <div class="footer">Generated \(self.escapeHTML(generatedAt))</div>
            </main>
          </body>
        </html>
        """
    }

    private static func buildEmptyStateHTML(
        title: String,
        generatedAt: String,
        statusLine: String,
        detailLines: [String],
        anchorStates: [LobsterWorkfacePanelAnchorState]) -> String
    {
        let presentLines = anchorStates.filter(\.present).map(\.path)
        let missingLines = anchorStates.filter { !$0.present }.map(\.path)
        return """
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>\(self.escapeHTML(title))</title>
            <style>
              :root {
                color-scheme: light;
                --bg: #f6f0e6;
                --ink: #231a15;
                --muted: #6c5e53;
                --panel: rgba(255, 252, 247, 0.96);
                --panel-border: rgba(74, 58, 44, 0.12);
                --accent: #8f4d19;
                --accent-soft: rgba(143, 77, 25, 0.12);
                --shadow: 0 22px 44px rgba(48, 32, 18, 0.12);
              }
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: "Avenir Next", "Segoe UI", sans-serif;
                color: var(--ink);
                background:
                  radial-gradient(circle at top left, rgba(143, 77, 25, 0.14), transparent 34%),
                  linear-gradient(180deg, #faf5ec 0%, var(--bg) 100%);
              }
              .frame { max-width: 1180px; margin: 0 auto; padding: 28px; }
              .hero, .panel {
                background: var(--panel);
                border: 1px solid var(--panel-border);
                border-radius: 28px;
                box-shadow: var(--shadow);
              }
              .hero { padding: 30px; display: grid; gap: 14px; }
              .eyebrow {
                text-transform: uppercase;
                letter-spacing: 0.18em;
                font-size: 12px;
                color: var(--muted);
              }
              h1 { margin: 0; font-size: clamp(32px, 5vw, 52px); line-height: 1; }
              .hero-copy { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
              .status-pill {
                display: inline-flex;
                width: fit-content;
                align-items: center;
                padding: 10px 14px;
                border-radius: 999px;
                background: var(--accent-soft);
                color: var(--accent);
                border: 1px solid rgba(143, 77, 25, 0.16);
                font-weight: 600;
              }
              .grid {
                display: grid;
                gap: 18px;
                margin-top: 20px;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
              }
              .hero-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-top: 6px;
              }
              .action-link {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 12px 16px;
                border-radius: 999px;
                border: 1px solid var(--panel-border);
                background: rgba(255, 255, 255, 0.78);
                color: var(--ink);
                text-decoration: none;
                font-size: 13px;
                font-weight: 600;
              }
              .panel { padding: 22px; }
              .panel h2 { margin: 0 0 14px; font-size: 18px; }
              .panel-list {
                list-style: none;
                padding: 0;
                margin: 0;
                display: grid;
                gap: 10px;
              }
              .panel-line {
                padding: 12px 14px;
                border-radius: 16px;
                background: rgba(17, 24, 39, 0.04);
                font-size: 14px;
                line-height: 1.45;
              }
              .panel-line.muted {
                color: var(--muted);
                background: rgba(17, 24, 39, 0.03);
              }
              .footer {
                margin-top: 18px;
                text-align: right;
                color: var(--muted);
                font-size: 13px;
              }
            </style>
          </head>
          <body>
            <main class="frame">
              <section class="hero">
                <div class="eyebrow">Lobster Panel</div>
                <h1>\(self.escapeHTML(title))</h1>
                <div class="status-pill">\(self.escapeHTML(statusLine))</div>
                <p class="hero-copy">
                  This panel is rendering an honest fallback state instead of pretending a daily Lobster workface visualization is ready.
                </p>
                <div class="hero-actions">
                  <a class="action-link" href="openclaw://lobster-panel">Refresh Panel</a>
                </div>
                \(self.renderParagraphs(detailLines))
              </section>

              <section class="grid">
                \(self.renderListPanel(title: "Expected Artifact", lines: [
                    "memory/YYYY-MM-DD-lobster-workface.md",
                    "Should contain learned / corrected / watchtower / carryover / token state",
                    "Reopen this panel after a new workface lands to refresh the view",
                ]))
                \(self.renderListPanel(title: "Protected Anchors Present", lines: presentLines))
                \(self.renderListPanel(title: "Protected Anchors Missing", lines: missingLines))
              </section>

              <div class="footer">Generated \(self.escapeHTML(generatedAt))</div>
            </main>
          </body>
        </html>
        """
    }

    private static func renderParagraphs(_ lines: [String]) -> String {
        lines
            .map { "<p class=\"hero-copy\">\(self.escapeHTML($0))</p>" }
            .joined(separator: "\n")
    }

    private static func renderMetricCard(label: String, value: String, tone: String) -> String {
        """
        <article class="metric-card \(tone)">
          <span class="metric-label">\(self.escapeHTML(label))</span>
          <strong class="metric-value">\(self.escapeHTML(value))</strong>
        </article>
        """
    }

    private static func renderCarryoverCard(label: String, value: String) -> String {
        """
        <article class="carryover-card">
          <span class="carryover-label">\(self.escapeHTML(label))</span>
          <strong class="carryover-value">\(self.escapeHTML(value))</strong>
        </article>
        """
    }

    private static func renderListPanel(title: String, lines: [String]) -> String {
        let renderedLines: String
        if lines.isEmpty {
            renderedLines = "<li class=\"panel-line muted\">No entries recorded.</li>"
        } else {
            renderedLines = lines
                .map { "<li class=\"panel-line\">\(self.escapeHTML(self.normalizeListLine($0)))</li>" }
                .joined(separator: "")
        }
        return """
        <section class="panel">
          <h2>\(self.escapeHTML(title))</h2>
          <ul class="panel-list">\(renderedLines)</ul>
        </section>
        """
    }

    private static func displayPath(_ url: URL) -> String {
        let path = url.standardizedFileURL.path
        let home = FileManager().homeDirectoryForCurrentUser.path
        if path == home {
            return "~"
        }
        if path.hasPrefix(home + "/") {
            return "~" + String(path.dropFirst(home.count))
        }
        return path
    }

    private static func relativeLabel(for artifactURL: URL, workspaceURL: URL) -> String {
        let workspacePath = workspaceURL.standardizedFileURL.path
        let artifactPath = artifactURL.standardizedFileURL.path
        if artifactPath == workspacePath {
            return artifactURL.lastPathComponent
        }
        if artifactPath.hasPrefix(workspacePath + "/") {
            return String(artifactPath.dropFirst(workspacePath.count + 1))
        }
        return artifactURL.lastPathComponent
    }

    private static func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
