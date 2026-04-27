import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct LobsterWorkfacePanelTests {
    private func makeTempDirectory(prefix: String) -> URL {
        FileManager().temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
    }

    private func write(_ content: String, to url: URL) throws {
        try FileManager().createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try content.write(to: url, atomically: true, encoding: .utf8)
    }

    private func buildWorkface(dateKey: String) -> String {
        """
        # Lobster Workface: \(dateKey)

        - **Scope**: yesterday operating view
        - **Session Key**: agent:lobster:main
        - **Learning Items**: 3
        - **Correction Notes**: 2
        - **Watchtower Signals**: 1
        - **Codex Escalations**: 1
        - **Active Surface Lanes**: 3
        - **Portfolio Scorecard**: 7.9/10
        - **Total Tokens**: 4321
        - **Estimated Cost**: $0.4200

        ## Dashboard Snapshot
        - Learning Flow: ███ 3 items
        - Corrections: ██ 2 items

        ## Validation Radar
        - Strongest Domain: fundamental_research
        - Weakest Domain: technical_daily
        - Hallucination Watch: macro narrative drift

        ## Feishu Lane Panel
        - Active Lanes: 3
        - control_room · session main · healthy

        ## Yesterday Learned
        - keep: retain the higher-bar ETF invalidation checklist
        - discard: stop carrying forward stale risk anchors
        - replay: rerun this cue when holdings thesis revalidation asks arrive
        - next eval: compare tomorrow's holdings brief against this carryover

        ## Yesterday Corrected
        - corrected: stopped flattening workflow truth into process truth.

        ## Yesterday Watchtower
        - watchtower: watch silent drift in validation quality.

        ## Reading Guide
        - Read carryover first, then validation radar, then lane panel.
        """
    }

    @Test
    func prepareArtifactsBuildsHonestEmptyStateWhenNoArtifactExists() async throws {
        let workspaceURL = self.makeTempDirectory(prefix: "openclaw-lobster-workspace")
        let stateDirURL = self.makeTempDirectory(prefix: "openclaw-lobster-state")
        defer {
            try? FileManager().removeItem(at: workspaceURL)
            try? FileManager().removeItem(at: stateDirURL)
        }

        try FileManager().createDirectory(
            at: workspaceURL.appendingPathComponent("memory", isDirectory: true),
            withIntermediateDirectories: true)
        try self.write(
            "# Current Research Line\n",
            to: workspaceURL.appendingPathComponent("memory/current-research-line.md"))

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDirURL.path]) {
            let artifacts = try LobsterWorkfacePanel.prepareArtifacts(
                workspaceURL: workspaceURL,
                generatedAt: Date(timeIntervalSince1970: 0))

            #expect(artifacts.emptyState)
            #expect(artifacts.sourceArtifactURL == nil)
            #expect(artifacts.statusLine == "No latest lobster-workface artifact is available yet.")

            let html = try String(contentsOf: artifacts.htmlURL, encoding: .utf8)
            #expect(html.contains("Expected artifact: memory/YYYY-MM-DD-lobster-workface.md"))
            #expect(html.contains("memory/current-research-line.md"))
            #expect(html.contains("memory/unified-risk-view.md"))
            #expect(html.contains("openclaw://lobster-panel"))
        }
    }

    @Test
    func prepareArtifactsBootstrapsFromCurrentResearchLineWhenWorkfaceIsMissing() async throws {
        let workspaceURL = self.makeTempDirectory(prefix: "openclaw-lobster-workspace")
        let stateDirURL = self.makeTempDirectory(prefix: "openclaw-lobster-state")
        defer {
            try? FileManager().removeItem(at: workspaceURL)
            try? FileManager().removeItem(at: stateDirURL)
        }

        try self.write(
            """
            # Current Research Line

            current_focus: finance-first research operating system
            top_decision: focus on holdings-quality research before adding more agent novelty
            current_session_summary: keep the current research line tight and decision-useful
            freshness: fresh
            primary_anchor: current-research-line
            recall_order: current-research-line -> verified anchors
            next_step: turn the current line into daily holdings analysis
            guardrail: research-only memory; no HFT drift

            ## Continuous Improvement
            - daily_improvement_rule: use compact reusable templates before inventing new answer shapes

            ## Memory Budget
            - active_recall_budget: prefer at most five high-priority anchors before drilling deeper

            ## Verified Anchors
            - memory/current-research-line.md
            - memory/2026-03-26-portfolio-sizing-discipline-template.md
            """,
            to: workspaceURL.appendingPathComponent("memory/current-research-line.md"))

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDirURL.path]) {
            let artifacts = try LobsterWorkfacePanel.prepareArtifacts(
                workspaceURL: workspaceURL,
                generatedAt: Date(timeIntervalSince1970: 0))

            #expect(artifacts.emptyState)
            #expect(artifacts.sourceArtifactURL?.lastPathComponent == "current-research-line.md")

            let html = try String(contentsOf: artifacts.htmlURL, encoding: .utf8)
            #expect(html.contains("showing current research line bootstrap"))
            #expect(html.contains("finance-first research operating system"))
            #expect(html.contains("focus on holdings-quality research before adding more agent novelty"))
            #expect(html.contains("turn the current line into daily holdings analysis"))
        }
    }

    @Test
    func prepareArtifactsUsesLatestWorkfaceArtifact() async throws {
        let workspaceURL = self.makeTempDirectory(prefix: "openclaw-lobster-workspace")
        let stateDirURL = self.makeTempDirectory(prefix: "openclaw-lobster-state")
        let outputDirURL = self.makeTempDirectory(prefix: "openclaw-lobster-output")
        defer {
            try? FileManager().removeItem(at: workspaceURL)
            try? FileManager().removeItem(at: stateDirURL)
            try? FileManager().removeItem(at: outputDirURL)
        }

        try self.write(
            self.buildWorkface(dateKey: "2026-04-08"),
            to: workspaceURL.appendingPathComponent("memory/2026-04-08-lobster-workface.md"))
        try self.write(
            self.buildWorkface(dateKey: "2026-04-09"),
            to: workspaceURL.appendingPathComponent("memory/2026-04-09-lobster-workface.md"))
        try self.write(
            "# Current Research Line\n",
            to: workspaceURL.appendingPathComponent("memory/current-research-line.md"))

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDirURL.path]) {
            let artifacts = try LobsterWorkfacePanel.prepareArtifacts(
                workspaceURL: workspaceURL,
                outputDirectoryURL: outputDirURL,
                generatedAt: Date(timeIntervalSince1970: 0))

            #expect(!artifacts.emptyState)
            #expect(artifacts.sourceArtifactURL?.lastPathComponent == "2026-04-09-lobster-workface.md")
            #expect(artifacts.htmlURL.path == outputDirURL.appendingPathComponent("index.html").path)
            let html = try String(contentsOf: artifacts.htmlURL, encoding: .utf8)
            #expect(html.contains("memory/2026-04-09-lobster-workface.md"))
            #expect(html.contains("retain the higher-bar ETF invalidation checklist"))
            #expect(html.contains("macro narrative drift"))
            #expect(html.contains("Protected anchors 1 present / 2 missing"))
            #expect(html.contains("openclaw://lobster-panel"))
        }
    }

    @MainActor
    @Test
    func prepareArtifactsFallsBackToConfiguredWorkspace() async throws {
        let workspaceURL = self.makeTempDirectory(prefix: "openclaw-lobster-workspace")
        let stateDirURL = self.makeTempDirectory(prefix: "openclaw-lobster-state")
        let configPath = stateDirURL.appendingPathComponent("openclaw.json")
        defer {
            try? FileManager().removeItem(at: workspaceURL)
            try? FileManager().removeItem(at: stateDirURL)
        }

        try self.write(
            self.buildWorkface(dateKey: "2026-04-10"),
            to: workspaceURL.appendingPathComponent("memory/2026-04-10-lobster-workface.md"))

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDirURL.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "agents": [
                    "defaults": [
                        "workspace": workspaceURL.path,
                    ],
                ],
            ])

            let artifacts = try LobsterWorkfacePanel.prepareArtifacts(generatedAt: Date(timeIntervalSince1970: 0))
            #expect(artifacts.workspaceURL.path == workspaceURL.path)
            #expect(artifacts.sourceArtifactURL?.lastPathComponent == "2026-04-10-lobster-workface.md")
        }
    }
}
