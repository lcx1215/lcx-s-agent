import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { probeOriginalContextFeedback } from "../../../test/fixtures/lcx-waterflow-context-feedback-probe.js";
import { createCentralToolRegistry } from "./tool-registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("uses the handoff-capable original owner without granting external authority", async () => {
  const declarations: { id: string; args: readonly string[] }[] = [];
  const registry = createCentralToolRegistry({
    execute: async (owner) => {
      declarations.push({ id: owner.id, args: [...owner.args] });
      return { observedOk: true };
    },
  });
  await registry.get("contextRecovery")!.execute({}, new AbortController().signal);
  expect(declarations).toEqual([{ id: "contextRecovery", args: ["--handoff", "--json"] }]);
  expect(registry.get("contextRecovery")!.allowedSideEffects).not.toContain("external_send");
});

it.each(["delivered_hold", "source_unavailable"] as const)(
  "makes %s change the next judgment through the original archive and narrow read (diagnostic owner adapter)",
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-context-feedback-"));
    roots.push(root);
    const unavailable = kind === "source_unavailable";
    const source = {
      id: "handoff_moduleAbsorption_source_recovered",
      ok: !unavailable,
      summary: unavailable
        ? "lcx-module-learning-absorption-gate.ts source unavailable: fixture read failure"
        : "source recovered",
    };
    const output = {
      observedOk: !unavailable,
      receipt: {
        ok: !unavailable,
        boundary: "local_context_recovery_exam_only",
        checkedAt: new Date().toISOString(),
        handoffForNewWindow: {
          sourceChecks: [{ id: "handoff_changeImpact_source_recovered", ok: true }, source],
          ...(unavailable
            ? {}
            : {
                moduleAbsorption: {
                  gateDecision: "hold_at_application_ready",
                  absorptionReady: false,
                },
              }),
        },
      },
    };
    const field = unavailable
      ? "/value/receipt/handoffForNewWindow/sourceChecks/1"
      : "/value/receipt/handoffForNewWindow/moduleAbsorption/gateDecision";
    const result = await probeOriginalContextFeedback(root, field, output);
    expect(result.ownerCalls).toBe(1);
    expect(result.receipts[0].steps[0].observedOk).toBe(!unavailable);
    expect(result.judgment?.[0]).toMatchObject({
      effect: unavailable ? "unresolved" : "retain",
      verification: unavailable ? "unresolved" : "reference_verified",
    });
    expect(result.receipts[2].brainCall.note).toContain(
      unavailable ? "source unavailable" : "application-ready hold",
    );
    expect(result.receipts[2].actionsProposed).toBe(0);
  },
);
