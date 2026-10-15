import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";

const nativePath = process.env.LCX_TRAINING_COOLDOWN_PROOF;
const indexPath = process.env.LCX_TRAINING_COOLDOWN_INDEX;
type ObjectValue = Record<string, unknown>;
const record = (value: unknown) => value as ObjectValue;
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

describe("one original awaited training cooldown control continuation", () => {
  it.skipIf(!nativePath || !indexPath)(
    "verifies retained completion and rejects five repinned failures",
    async () => {
      const nativeBytes = await fs.readFile(nativePath!, "utf8");
      const native = JSON.parse(nativeBytes) as ObjectValue;
      const index = JSON.parse(await fs.readFile(indexPath!, "utf8")) as WorkflowHandoffEvidence[];
      const original = index.find(
        (row) => row.scenarioId === "training_failure_feedback_waterflow",
      );
      expect(original).toBeDefined();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-cooldown-control-audit-"));
      const results: unknown[] = [];
      try {
        for (const fault of [
          undefined,
          "missing",
          "early",
          "wrong_caller",
          "producer_alias",
          "source_pin",
        ] as const) {
          const body = structuredClone(native);
          const rows = body.receipts as ObjectValue[];
          const completedIndex = rows.findIndex(
            (row) => row.event === "evolution_cooldown_completed" && row.round === 1,
          );
          expect(completedIndex).toBeGreaterThan(0);
          if (fault === "missing") {
            rows[completedIndex] = { event: "completion_not_observed" };
          }
          if (fault === "wrong_caller") {
            rows[completedIndex].callerRef = {
              ...record(rows[completedIndex].callerRef),
              runId: "foreign-guard-run",
            };
          }
          if (fault === "early") {
            const next = record((body.quotaRuns as ObjectValue[])[1]);
            const quotaRows = next.receipts as ObjectValue[];
            quotaRows[0].at = rows[completedIndex].startedAt;
            const log = record(next.logReadback);
            const lines = String(log.raw).split(/\r?\n/u);
            lines[0] = JSON.stringify(quotaRows[0]);
            log.raw = lines.join("\n");
          }
          const file = path.join(root, `${fault ?? "positive"}.json`);
          const bytes = JSON.stringify(body);
          await fs.writeFile(file, bytes);
          const row = structuredClone(original!);
          const repin = (value: unknown) => {
            if (!value || typeof value !== "object") {
              return;
            }
            const object = value as ObjectValue;
            if (
              typeof object.path === "string" &&
              typeof object.sha256 === "string" &&
              typeof object.pointer === "string"
            ) {
              object.path = file;
              object.sha256 = digest(bytes);
            }
            for (const child of Object.values(object)) {
              repin(child);
            }
          };
          repin(row);
          const source = record(record(body.source).guard);
          row.controlContinuations = [
            {
              kind: "training_cooldown_resume",
              from: "evolution_cooldown",
              to: "teacher_quota",
              receipt: {
                path: file,
                sha256: digest(bytes),
                pointer: fault === "producer_alias" ? "/receipts/12/event" : "",
              },
              guardSource: {
                path: String(source.path),
                sha256: fault === "source_pin" ? "0".repeat(64) : String(source.sha256),
              },
            },
          ];
          const audited = (await auditWorkflowHandoffs([row])).find(
            (result) => result.scenarioId === row.scenarioId,
          );
          results.push({
            fault: fault ?? "positive",
            source: { path: file, sha256: digest(bytes) },
            row,
            audited,
          });
          expect(audited).toBeDefined();
          if (!fault) {
            expect(audited?.gaps).toEqual([]);
            expect(audited?.status).toBe("normal_block");
            expect(audited?.blocked).toEqual(["adapter_resolver"]);
            expect(audited?.controlContinuationsObserved).toEqual([
              "evolution_cooldown->teacher_quota",
            ]);
            expect(audited?.semanticAdoption).toBe("not_proven");
          } else {
            expect(audited?.status).toBe("handoff_gap");
            expect(audited?.gaps.some((gap) => gap.reason.startsWith("cooldown_control_"))).toBe(
              true,
            );
            expect(
              audited?.gaps.some(
                (gap) => gap.reason === "consumer_did_not_receive_output:evolution_cooldown",
              ),
            ).toBe(true);
          }
        }
        if (process.env.LCX_TRAINING_COOLDOWN_AUDIT_OUTPUT) {
          await fs.writeFile(
            process.env.LCX_TRAINING_COOLDOWN_AUDIT_OUTPUT,
            JSON.stringify({ nativePath, nativeSha256: digest(nativeBytes), results }, null, 2) +
              "\n",
          );
        }
      } finally {
        // A retained output must keep each genuinely repinned counterexample readable.
        if (!process.env.LCX_TRAINING_COOLDOWN_AUDIT_OUTPUT) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
});
