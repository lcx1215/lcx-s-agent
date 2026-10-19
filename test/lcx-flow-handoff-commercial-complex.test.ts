import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as commercial from "../src/agents/commercial-answer-pipeline.js";
import * as visible from "../src/agents/visible-answer-adoption-gate.js";
import { resetInboundDedupe } from "../src/auto-reply/reply/inbound-dedupe.js";
import { onAgentEvent, type AgentEventPayload } from "../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../src/infra/system-events.js";
import {
  produceOriginalComplexCouncil,
  COMMERCIAL_COMPLEX_ASK,
} from "./fixtures/lcx-waterflow-commercial-complex-probe.js";
import { probeOriginalDefaultLanguageReply } from "./fixtures/lcx-waterflow-language-default-probe.js";

const io = vi.hoisted(() => ({ role: vi.fn(), reply: vi.fn(), forbidden: [] as string[] }));
vi.mock("../src/commands/agent.js", () => ({
  agentCommand: (...args: unknown[]) => io.role(...args),
}));
vi.mock("../src/gateway/call.js", () => ({
  callGateway: () => {
    throw new Error("gateway forbidden");
  },
  randomIdempotencyKey: () => "offline-commercial-complex",
}));
vi.mock("../src/cli/deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("../src/infra/operational-anomalies.js", () => ({ recordOperationalAnomaly: vi.fn() }));
vi.mock("../src/agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
  }),
}));
vi.mock("../src/agents/pi-embedded.js", async () => ({
  ...(await vi.importActual<typeof import("../src/agents/pi-embedded-runner/runs.js")>(
    "../src/agents/pi-embedded-runner/runs.js",
  )),
  ...(await vi.importActual<typeof import("../src/agents/pi-embedded-runner/lanes.js")>(
    "../src/agents/pi-embedded-runner/lanes.js",
  )),
  compactEmbeddedPiSession: async () => {
    throw new Error("offline compaction forbidden");
  },
  queueEmbeddedPiMessage: () => false,
  runEmbeddedPiAgent: (params: unknown) => io.reply(params),
}));
vi.mock("../src/agents/pi-embedded-runner/run.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => io.reply(params),
}));
vi.mock("../src/agents/cli-runner.js", async (original) => ({
  ...(await original<typeof import("../src/agents/cli-runner.js")>()),
  runCliAgent: () => {
    io.forbidden.push("CLI provider");
    throw new Error("CLI provider forbidden");
  },
}));
vi.mock("../src/cron/store.js", async (original) => ({
  ...(await original<typeof import("../src/cron/store.js")>()),
  loadCronStore: async () => ({ version: 1, jobs: [] }),
}));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("../src/shared/global-evidence-projection-source.js", () => ({
  readCanonicalGlobalEvidenceProjectionCandidate: async () => null,
}));
function deny(kind: string) {
  return () => {
    io.forbidden.push(kind);
    throw new Error(`forbidden:${kind}`);
  };
}
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  const guarded = {
    ...module,
    spawn: deny("spawn"),
    spawnSync: deny("spawnSync"),
    exec: deny("exec"),
    execSync: deny("execSync"),
    execFile: deny("execFile"),
    execFileSync: deny("execFileSync"),
    fork: deny("fork"),
  };
  return { ...guarded, default: guarded };
});
vi.mock("node:http", async (original) => {
  const module = await original<typeof import("node:http")>();
  const guarded = { ...module, request: deny("http.request"), get: deny("http.get") };
  return { ...guarded, default: guarded };
});
vi.mock("node:https", async (original) => {
  const module = await original<typeof import("node:https")>();
  const guarded = { ...module, request: deny("https.request"), get: deny("https.get") };
  return { ...guarded, default: guarded };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  io.role.mockReset();
  io.reply.mockReset();
  io.forbidden.length = 0;
  resetSystemEventsForTest();
  resetInboundDedupe();
  await Promise.all(
    temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it.each(["matched", "source_hash_conflict"] as const)(
  "runs original complex council and actual default reply terminal for %s",
  async (fault) => {
    const retained = process.env.LCX_COMMERCIAL_COMPLEX_PROOF_DIR;
    if (retained) {
      await fs.mkdir(retained, { recursive: true });
    }
    const directory = await fs.mkdtemp(
      path.join(retained ?? os.tmpdir(), `commercial-complex-${fault}-`),
    );
    if (!retained) {
      temporary.push(directory);
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("LCX_LEARNING_COUNCIL_TRANSPORT", "in-process");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_KIMI_MODEL", "moonshot/kimi-k2.6");
    vi.stubEnv("OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL", "minimax-portal/MiniMax-M2.7");
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "MINIMAX_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "MOONSHOT_API_KEY",
    ]) {
      vi.stubEnv(key, "");
    }
    const roleCalls: Array<{
      input: { model: string; sessionKey: string; message: string; extraSystemPrompt: string };
      output: unknown;
    }> = [];
    const synthesis =
      "## Synthesis\n- CPI and FOMC risk can change rate expectations and correlated QQQ/TLT exposure; no direction prediction.\n## Freshness and caveats\n- Current prices, holdings, costs and source timestamps are missing. This is research only.\n## Provisional anchors\n- Invalidation is contradictory source evidence; no execution authority.";
    const extraction =
      "## Extracted lessons\n- Evidence ordering beats model votes. No source trust claim and no learned-skill claim.\n## Candidate follow-ups\n- Obtain original dated source and account risk inputs.\n## Weak evidence\n- Market and position data are not supplied.";
    let challenges = 0;
    io.role.mockImplementation(async (input: (typeof roleCalls)[number]["input"]) => {
      const text = input.model.startsWith("moonshot/")
        ? synthesis
        : input.model.startsWith("custom-api-deepseek-com/")
          ? extraction
          : `## What holds up\n- Research is provisional, never a final trading authority.\n## Challenges\n- ${++challenges === 1 ? "FIRST_NATIVE_CHALLENGE" : "SECOND_NATIVE_CHALLENGE"}: require original source, account inputs and falsifiers; do not resolve disagreement by majority.\n## Evidence gaps\n- Current data are missing. No execution authority.`;
      if (input.model.startsWith("minimax")) {
        expect(input.extraSystemPrompt).toContain(synthesis);
        expect(input.extraSystemPrompt).toContain(extraction);
      }
      const slash = input.model.indexOf("/");
      const output = {
        payloads: [{ text }],
        meta: {
          agentMeta: { provider: input.model.slice(0, slash), model: input.model.slice(slash + 1) },
        },
      };
      roleCalls.push({ input: structuredClone(input), output: structuredClone(output) });
      return output;
    });
    const council = await produceOriginalComplexCouncil(directory);
    expect(roleCalls).toHaveLength(4);
    expect(challenges).toBe(2);
    expect(roleCalls[3].input.extraSystemPrompt).toContain("FIRST_NATIVE_CHALLENGE");
    const modelInputs: Array<Record<string, unknown>> = [];
    const modelOutputs: unknown[] = [];
    io.reply.mockImplementation(
      async (input: {
        runId: string;
        sessionKey: string;
        sessionId: string;
        prompt: string;
        extraSystemPrompt?: string;
      }) => {
        modelInputs.push({
          runId: input.runId,
          sessionKey: input.sessionKey,
          sessionId: input.sessionId,
          prompt: input.prompt,
          extraSystemPrompt: input.extraSystemPrompt,
        });
        const output = {
          payloads: [{ text: council.finalReply }],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-5" } },
        };
        modelOutputs.push(structuredClone(output));
        return output;
      },
    );
    const auditCalls: Array<{
      input: Parameters<typeof commercial.buildPipelineResult>;
      output: ReturnType<typeof commercial.buildPipelineResult>;
    }> = [];
    const nativeBuilder = commercial.buildPipelineResult;
    vi.spyOn(commercial, "buildPipelineResult").mockImplementation((...input) => {
      const output = nativeBuilder(...input);
      auditCalls.push({ input: structuredClone(input), output: structuredClone(output) });
      return output;
    });
    const presentationCalls: Array<{
      input: Parameters<typeof visible.applyVisibleAnswerAdoptionGate>[0];
      output: ReturnType<typeof visible.applyVisibleAnswerAdoptionGate>;
    }> = [];
    const nativeVisible = visible.applyVisibleAnswerAdoptionGate;
    vi.spyOn(visible, "applyVisibleAnswerAdoptionGate").mockImplementation((input) => {
      const output = nativeVisible(input);
      presentationCalls.push({ input: structuredClone(input), output: structuredClone(output) });
      return output;
    });
    const receiver: Array<Record<string, unknown>> = [];
    const outboundRequests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (target !== "https://93.184.216.34/messages" || typeof init?.body !== "string") {
        io.forbidden.push(target);
        throw new Error("non-receiver network forbidden");
      }
      outboundRequests.push({ url: target, body: init.body });
      receiver.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response("", { status: 200 });
    });
    const probe = await probeOriginalDefaultLanguageReply(directory, {
      ask: COMMERCIAL_COMPLEX_ASK,
      replyOptions: {
        commercialAnswerAudit: {
          messageId: council.input.messageId,
          askSha256: createHash("sha256").update(COMMERCIAL_COMPLEX_ASK).digest("hex"),
          input: {
            providerEvidence:
              fault === "matched"
                ? council.evidence
                : { ...council.evidence, sha256: "0".repeat(64) },
          },
        },
      },
    });
    const events: AgentEventPayload[] = [];
    const stop = onAgentEvent((event) => events.push(structuredClone(event)));
    let ingress;
    try {
      ingress = await probe.submit(probe.message);
    } finally {
      stop();
    }
    const proof = {
      boundary: "explicit_original_council_entry_and_default_reply_no_natural_or_semantic_claim",
      fault,
      council,
      roleCalls,
      modelInputs,
      modelOutputs,
      auditCalls,
      presentationCalls,
      events,
      ingress,
      originalIngress: probe.inputs,
      dispatchResults: probe.dispatchResults,
      receiver,
      outboundRequests,
      errors: probe.errors,
      forbiddenTransport: [...io.forbidden],
      missingActualCallers: [
        "default_reply_to_council_invocation",
        "qwen_challenger_actual_model_call",
        "independent_review_panel_execution",
      ],
    };
    if (retained) {
      await fs.writeFile(
        path.join(directory, "native-proof.json"),
        JSON.stringify(proof, null, 2) + "\n",
      );
    }
    expect(io.forbidden).toEqual([]);
    expect(modelInputs).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(receiver.length).toBeGreaterThan(0);
    const audit = auditCalls[0];
    expect(audit.input[0]).toBe(COMMERCIAL_COMPLEX_ASK);
    const actualPresentation = presentationCalls.find(
      (call) =>
        call.input.presentationOnly &&
        call.input.answerText === council.finalReply &&
        call.output.text === audit.input[1],
    );
    expect(actualPresentation).toBeDefined();
    expect(audit.output.controlRoomSummary.text).toBe(receiver[0].text);

    expect(audit.input[3]?.runId).toBe(modelInputs[0].runId);
    expect(audit.output.remoteProviderCouncil.required).toBe(true);
    expect(audit.output.minimaxAgentDraftContract.status).toBe(
      "use_as_high_quality_draft_when_available",
    );
    expect(audit.output.consumedEvidence.providerCouncil.status).toBe(
      fault === "matched" ? "verified" : "invalid",
    );
    const terminalEvent = events.find(
      (event) => event.data.phase === "commercial_answer_terminal_gate",
    );
    expect(terminalEvent?.data.auditInvocation).toEqual(audit.output.auditInvocation);
    expect(terminalEvent?.data.controlRoomSummary).toEqual(audit.output.controlRoomSummary);
    if (fault === "source_hash_conflict") {
      expect(audit.output.terminalDecision).toBe("return_failed_reason");
      expect(receiver.some((message) => String(message.text).includes("provider_council"))).toBe(
        true,
      );
    }
  },
  30000,
);
