import Foundation
import Testing
@testable import OpenClaw

struct LCXAgentControlRoomTests {
    @Test
    func snapshotBuildsDepartmentsFromOwnerDigest() {
        let snapshot = LCXAgentControlRoomSnapshot.build(
            autopilot: [
                "ok": true,
                "checkedAt": "2026-05-27T22:44:40.279Z",
                "summary": [
                    "parsedOwners": 13,
                    "activeTrainingOrEval": true,
                    "blockedClusters": [
                        "module_learning_absorption_cluster",
                    ],
                    "blockedGates": [
                        "live_runtime_not_updated",
                    ],
                    "fastestSafeNextAction": "wait_for_current_training_eval_then_run_idle_queue",
                    "externalUpgradeBlacktechMechanismCount": 6,
                    "externalUpgradeBlacktechAutopilotRoutedCount": 6,
                    "externalUpgradeBlacktechRuntimeAuthorityGrantedCount": 0,
                ],
            ],
            digest: [
                "repo": [
                    "statusShortBranch": "## codex/governance-autopilot-readme",
                    "dirtyCount": 35,
                ],
                "material": [
                    "activeHeavy": true,
                    "activePidCounts": [
                        "guard": 1,
                        "eval": 1,
                        "mlx": 1,
                    ],
                    "selectedCleanAdapter": "/tmp/adapters/clean-r2",
                    "latestCandidateEval": [
                        "adapterPath": "/tmp/adapters/challenger-r4",
                        "promotionReady": false,
                        "failedCaseIds": [],
                        "parseRecoveredCaseIds": [
                            "case_a",
                            "case_b",
                        ],
                    ],
                    "liveLarkBrainBindingStatus": "legacy_status_should_not_win",
                    "externalChannelBindingStatus": "deferred_active_training_or_eval",
                    "liveBindingMissingProof": [
                        "current_training_eval_or_mlx_finished",
                        "fresh_real_lark_inbound_and_outbound_seen",
                    ],
                    "skillOptLiteStatus": "candidate_edit_static_accepted_pending_eval",
                    "skillOptLiteMatchedSkillIds": [
                        "finance_data_provenance_preflight",
                    ],
                    "skillOptLiteNextIdleAction": "run_targeted_eval_then_accept_or_reject_skill_edit",
                    "providerCouncilAccelerationStatus": "ready_plan",
                    "providerCouncilAccelerationAction": "dry_run_plan_only",
                    "providerCouncilAccelerationHardBlocks": [
                        "active_eval_or_mlx",
                    ],
                ],
            ],
            handoff: """
            generatedAt: 2026-05-27T22:44:40.279Z
            boundary: dev_context_recovery_handoff_only
            """,
            handoffPath: "/tmp/lcx-context-recovery-handoff-latest.md")

        #expect(snapshot.repoDirtyCount == 35)
        #expect(snapshot.activeHeavy)
        #expect(snapshot.activePidCounts["mlx"] == 1)
        #expect(snapshot.selectedCleanAdapter == "clean-r2")
        #expect(snapshot.latestCandidateAdapter == "challenger-r4")
        #expect(snapshot.parseRecoveredCount == 2)
        #expect(snapshot.blacktechMechanismCount == 6)
        #expect(snapshot.blacktechRoutedCount == 6)
        #expect(snapshot.blacktechRuntimeAuthorityCount == 0)
        #expect(snapshot.liveBindingMissingProof.count == 2)
        #expect(snapshot.handoffGeneratedAt == "2026-05-27T22:44:40.279Z")
        #expect(snapshot.departments.count == 8)
        #expect(snapshot.departments.contains { $0.id == "skillopt" && $0.detail.contains("finance_data_provenance_preflight") })
        #expect(snapshot.departments.contains { $0.id == "live" && $0.status == "deferred_active_training_or_eval" })
    }

    @Test
    func missingSnapshotsBecomeHonestEmptyState() {
        let snapshot = LCXAgentControlRoomSnapshot.build(
            autopilot: [:],
            digest: [:],
            handoff: "",
            handoffPath: "/tmp/missing.md")

        #expect(snapshot.sourceReadStatus == "owner snapshots missing")
        #expect(snapshot.fastestSafeNextAction == "refresh owner state")
        #expect(snapshot.liveBindingStatus == "unknown")
        #expect(snapshot.departments.count == 8)
    }
}
