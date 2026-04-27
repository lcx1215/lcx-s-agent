import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeProtocolInfoText,
  resolveProtocolInfoQuestionKind,
} from "./commands-protocol-families.js";
import { buildProtocolInfoReply } from "./commands-protocol-info.js";

describe("commands-protocol-info", () => {
  it("normalizes trailing punctuation and repeated spaces", () => {
    expect(normalizeProtocolInfoText("  lobster开了吗？？ ")).toBe("lobster开了吗");
    expect(normalizeProtocolInfoText("what   is your default mode?!")).toBe(
      "what is your default mode",
    );
  });

  it.each([
    ["现在系统是什么状态", "snapshot"],
    ["现在在干什么", "status_readback"],
    ["继续，现在在干什么", "status_readback"],
    ["现在修到哪了", "status_readback"],
    ["还剩多少", "status_readback"],
    ["继续，现在还剩什么", "status_readback"],
    ["是不是 live 了", "status_readback"],
    ["how do you work", "help"],
    ["你现在按什么协议工作", "help"],
    ["is lobster on", "lobster"],
    ["lobster开了吗？", "lobster"],
    ["are dm sessions isolated", "dm"],
    ["私聊隔离吗", "dm"],
    ["默认模型是什么", "model"],
    ["搜索现在正常吗", "search_health"],
    ["哪些工具真的接上了", "capabilities"],
    ["哪些工具是真的能用", "capabilities"],
    ["你能用 web-search 吗", "specific_capability"],
    ["你能用 quickjs 吗", "specific_capability"],
    ["你现在到底有没有 web-search 能力", "specific_capability"],
    ["你现在还不能做什么", "limitations"],
    ["今天真的学进去了吗", "learning"],
    ["学习 session 现在还活着吗", "learning_receipt"],
    ["你会怎么学习arxiv上的文章并学会应用", "learning_application"],
    ["你是不是把单次 pass 说成后台持续学习了", "promise_risk"],
    ["你是不是还没写进长期记忆", "persistence_state"],
    ["写入是不是失败了但当前session里已经懂了", "write_outcome"],
    ["这次真的落盘了吗", "write_outcome"],
    ["你别跟我讲感觉，就说这次到底落盘没有", "write_outcome"],
    ["你会越对话越聪明吗", "improvement"],
    ["这次错在什么类型", "error_type"],
    ["当前运行模型是什么", "runtime_model"],
    ["现在是哪个模型在回我", "runtime_model"],
    ["为什么不是默认模型", "fallback_reason"],
    ["是不是偷偷 fallback 了", "fallback_reason"],
    ["what protected anchors are missing", "anchors"],
  ] as const)("classifies %s as %s", (question, expected) => {
    expect(resolveProtocolInfoQuestionKind(question)).toBe(expected);
  });

  it.each([
    ["你现在能不能用 web-search", "specific_capability"],
    ["what remains", "status_readback"],
    ["is this live-fixed", "status_readback"],
    ["where are we now", "status_readback"],
    ["can you use file_search", "specific_capability"],
    ["今天到底学进去了没有", "learning"],
    ["is web search working now", "search_health"],
    ["你到底有没有搜索能力", "search_health"],
    ["你刚才真的开始学那篇论文了吗", "learning_receipt"],
    ["写进脑子还是躺在 report 里装样子", "learning_receipt"],
    ["can you learn from new arxiv papers and apply it", "learning_application"],
    ["did you pretend a background learning session started", "promise_risk"],
    ["did that reach long-term storage", "persistence_state"],
    ["did the write fail but stay understood in the current session", "write_outcome"],
    ["这是不是已经持久化了", "write_outcome"],
    ["是不是还没落进长期记忆", "persistence_state"],
    ["刚才那次写入是真持久化了，还是只在当前会话里懂了", "write_outcome"],
    ["你是不是把昨天的写失败还当成今天没写进去", "write_outcome"],
    ["那个回答哪里不对", "improvement"],
    ["was that overclaiming", "error_type"],
    ["现在有哪些能力接上了", "capabilities"],
    ["还有哪些能力没接上", "limitations"],
    ["provider 工具现在还缺什么", "limitations"],
  ] as const)("classifies flexible variant %s as %s", (question, expected) => {
    expect(resolveProtocolInfoQuestionKind(question)).toBe(expected);
  });

  it("returns null for unrelated text", () => {
    expect(resolveProtocolInfoQuestionKind("tell me a joke")).toBeNull();
    expect(
      resolveProtocolInfoQuestionKind("去学习arxiv上新的文章里的有用的地方，并学会应用"),
    ).toBeNull();
    expect(buildProtocolInfoReply({ text: "tell me a joke" })).toBeNull();
    expect(
      buildProtocolInfoReply({ text: "去学习arxiv上新的文章里的有用的地方，并学会应用" }),
    ).toBeNull();
  });

  it("builds direct snapshot, lobster, dm, model, specific capability, capabilities, limitations, learning, learning-application, improvement, error-type, runtime-model, fallback-reason, and anchor replies from shared protocol state", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "memory", "current-research-line.md"), "# current\n");
      fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# memory\n");
      fs.writeFileSync(
        path.join(workspace, "memory", "2026-04-23-lobster-workface.md"),
        [
          "# Lobster Workface: 2026-04-23",
          "",
          "- Learning Items: 1",
          "",
          "## Yesterday Learned",
          "- keep: ranking is not sizing",
          "- discard: fake precision from unconstrained optimization",
          "- replay: ask what evidence would falsify the sizing rule",
          "- next eval: check whether this changed today's evidence threshold",
          "",
        ].join("\n"),
      );
      fs.mkdirSync(path.join(workspace, "memory", "feishu-learning-timeboxes"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(
          workspace,
          "memory",
          "feishu-learning-timeboxes",
          "2026-04-23T10-00-00.000Z__oc-learning.json",
        ),
        JSON.stringify({
          version: 1,
          sessionId: "2026-04-23T10-00-00.000Z__oc-learning",
          status: "running",
          startedAt: "2026-04-23T10:00:00.000Z",
          deadlineAt: "2099-04-23T11:00:00.000Z",
          lastHeartbeatAt: "2026-04-23T10:20:00.000Z",
          iterationsCompleted: 2,
          iterationsFailed: 0,
        }),
      );

      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;

      const snapshotReply = buildProtocolInfoReply({
        text: "现在系统是什么状态",
        cfg,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "minimax-portal",
          model: "MiniMax-M2.7",
          fallbackNoticeSelectedModel: "moonshot/kimi-k2.6",
          fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
          fallbackNoticeReason: "rate limit",
        },
      });
      expect(snapshotReply?.text).toContain("📍 Operator snapshot");
      expect(snapshotReply?.text).toContain(
        "Mode: control_room_main_lane · openclaw_embedded_agent",
      );
      expect(snapshotReply?.text).toContain("Model: minimax-portal/MiniMax-M2.7");
      expect(snapshotReply?.text).toContain("Selected: moonshot/kimi-k2.6");
      expect(snapshotReply?.text).toContain("Capability mode: unavailable");
      expect(snapshotReply?.text).toContain("Provider tools: not connected");
      expect(snapshotReply?.text).toContain("Fallback: rate limit");
      expect(snapshotReply?.text).toContain("Missing anchors: memory/unified-risk-view.md");

      const statusReadbackReply = buildProtocolInfoReply({
        text: "现在修到哪了",
        cfg,
      });
      expect(statusReadbackReply?.text).toContain("🧭 Status readback");
      expect(statusReadbackReply?.text).toContain(
        "Classification: this is a status-readback request",
      );
      expect(statusReadbackReply?.text).toContain(
        "Evidence order: repo state -> scoped diff or commit receipt -> targeted test or lint receipt -> migration/build/restart receipt -> live probe receipt -> visible Lark/Feishu reply-flow evidence.",
      );
      expect(statusReadbackReply?.text).toContain(
        "Dev-fixed: only supported by current local implementation plus scoped verification receipts.",
      );
      expect(statusReadbackReply?.text).toContain(
        "Live-fixed: unproven unless migration, build, restart, live probe, and visible Lark/Feishu reply evidence are all present.",
      );
      expect(statusReadbackReply?.text).toContain(
        "Latest durable learning artifact: present (2026-04-23)",
      );
      expect(statusReadbackReply?.text).toContain(
        "Latest learning session receipt: running (2026-04-23T10-00-00.000Z__oc-learning)",
      );
      expect(statusReadbackReply?.text).toContain("Latest write anomaly: none found");
      expect(statusReadbackReply?.text).toContain(
        "Next check: name the first missing evidence layer",
      );

      const lobsterReply = buildProtocolInfoReply({ text: "lobster开了吗？", cfg });
      expect(lobsterReply?.text).toContain("🦞 Lobster");
      expect(lobsterReply?.text).toContain("Plugin: optional");

      const dmReply = buildProtocolInfoReply({ text: "dm隔离吗", cfg });
      expect(dmReply?.text).toContain("🧵 DM scope");
      expect(dmReply?.text).toContain("DM sessions default to main");

      const modelReply = buildProtocolInfoReply({ text: "默认模型是什么", cfg });
      expect(modelReply?.text).toContain("🧠 Default model");
      expect(modelReply?.text).toContain("moonshot/kimi-k2.6");

      const searchHealthReply = buildProtocolInfoReply({
        text: "搜索现在正常吗",
        cfg: {
          ...cfg,
          models: {
            providers: {
              moonshot: { api: "openai-completions", models: [{ id: "kimi-k2.6" }] },
            },
          },
        } as OpenClawConfig,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      });
      expect(searchHealthReply?.text).toContain("🔎 Search and provider health");
      expect(searchHealthReply?.text).toContain("Active model: moonshot/kimi-k2.6");
      expect(searchHealthReply?.text).toContain("Provider-native search: not connected");
      expect(searchHealthReply?.text).toContain("OpenClaw web_search: connected");
      expect(searchHealthReply?.text).toContain("Recent degradation record: none found");
      expect(searchHealthReply?.text).toContain(
        "Current truth here is runtime/config surface only, not a fresh live probe.",
      );
      expect(searchHealthReply?.text).toContain(
        "This distinguishes current configured/connected state from stale past failures.",
      );

      const capabilitiesReply = buildProtocolInfoReply({
        text: "哪些工具真的接上了",
        cfg,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "minimax-portal",
          model: "MiniMax-M2.7",
        },
      });
      expect(capabilitiesReply?.text).toContain("🧰 Connected capabilities");
      expect(capabilitiesReply?.text).toContain("Active model: minimax-portal/MiniMax-M2.7");
      expect(capabilitiesReply?.text).toContain("Provider-native tools: none connected");
      expect(capabilitiesReply?.text).toContain(
        "OpenClaw tools: web_search, web_fetch, memory_search",
      );

      const specificCapabilityReply = buildProtocolInfoReply({
        text: "你能用 web-search 吗",
        cfg: {
          ...cfg,
          models: {
            providers: {
              moonshot: { api: "openai-completions", models: [{ id: "kimi-k2.6" }] },
            },
          },
        } as OpenClawConfig,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      });
      expect(specificCapabilityReply?.text).toContain("🔎 Capability check: web-search");
      expect(specificCapabilityReply?.text).toContain("Provider-native web-search: not connected");
      expect(specificCapabilityReply?.text).toContain("OpenClaw web_search: connected");
      expect(specificCapabilityReply?.text).toContain("runtime truth, not provider marketing");

      const providerOnlyCapabilityReply = buildProtocolInfoReply({
        text: "你能用 quickjs 吗",
        cfg: {
          ...cfg,
          models: {
            providers: {
              moonshot: { api: "openai-completions", models: [{ id: "kimi-k2.6" }] },
            },
          },
        } as OpenClawConfig,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      });
      expect(providerOnlyCapabilityReply?.text).toContain("🔎 Capability check: quickjs");
      expect(providerOnlyCapabilityReply?.text).toContain("Provider-native quickjs: not connected");
      expect(providerOnlyCapabilityReply?.text).toContain("OpenClaw generic tool: none");

      const limitationsReply = buildProtocolInfoReply({
        text: "你现在还不能做什么",
        cfg: {
          ...cfg,
          models: {
            providers: {
              moonshot: { api: "openai-completions", models: [{ id: "kimi-k2.6" }] },
            },
          },
        } as OpenClawConfig,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      });
      expect(limitationsReply?.text).toContain("⛔ Capability limits");
      expect(limitationsReply?.text).toContain("Active model: moonshot/kimi-k2.6");
      expect(limitationsReply?.text).toContain(
        "Provider-native tools not connected: web-search, fetch, memory, excel, date, quickjs, code_runner, rethink",
      );
      expect(limitationsReply?.text).toContain("runtime truth, not provider marketing");

      const learningReply = buildProtocolInfoReply({ text: "今天真的学进去了吗", cfg });
      expect(learningReply?.text).toContain("📚 Learning status");
      expect(learningReply?.text).toContain("Evidence: lobster-workface 2026-04-23");
      expect(learningReply?.text).toContain(
        "Carryover cue: complete (retain / discard / replay / next eval).",
      );
      expect(learningReply?.text).toContain("Retained: ranking is not sizing");
      expect(learningReply?.text).toContain(
        "Discarded: fake precision from unconstrained optimization",
      );
      expect(learningReply?.text).toContain(
        "Replay: ask what evidence would falsify the sizing rule",
      );
      expect(learningReply?.text).toContain(
        "This is the latest explicit learning evidence, not a self-claim.",
      );

      const learningReceiptReply = buildProtocolInfoReply({
        text: "学习 session 现在还活着吗",
        cfg,
      });
      expect(learningReceiptReply?.text).toContain("🧾 Learning task receipt");
      expect(learningReceiptReply?.text).toContain(
        "Latest session receipt: 2026-04-23T10-00-00.000Z__oc-learning",
      );
      expect(learningReceiptReply?.text).toContain("Workflow status: running");
      expect(learningReceiptReply?.text).toContain("Progress: completed 2 · failed 0");
      expect(learningReceiptReply?.text).toContain("Recent workflow risk: none found");
      expect(learningReceiptReply?.text).toContain("Durable artifact: lobster-workface 2026-04-23");
      expect(learningReceiptReply?.text).toContain(
        "Carryover cue: complete (retain / discard / replay / next eval).",
      );
      expect(learningReceiptReply?.text).toContain(
        "Execution vs explanation: I can prove both a workflow receipt and a durable learning artifact.",
      );
      expect(learningReceiptReply?.text).toContain(
        "This answer is bounded to recorded receipts and durable artifacts, not guesswork.",
      );

      const learningApplicationReply = buildProtocolInfoReply({
        text: "你会怎么学习arxiv上的文章并学会应用",
        cfg,
      });
      expect(learningApplicationReply?.text).toContain("🧪 Learning and application");
      expect(learningApplicationReply?.text).toContain(
        "Acquisition: I can review new papers, extract bounded useful claims, and compare them against current doctrine and existing anchors.",
      );
      expect(learningApplicationReply?.text).toContain(
        "Carryover cue: complete (retain / discard / replay / next eval).",
      );
      expect(learningApplicationReply?.text).toContain(
        "Internalization: I only count it as learned when the result is recorded as a reusable lesson, replay cue, or next-eval item.",
      );
      expect(learningApplicationReply?.text).toContain(
        "Application: I should apply it through explicit summaries, correction notes, and later decisions, not by claiming instant permanent mastery.",
      );
      expect(learningApplicationReply?.text).toContain(
        "Latest retained lesson: ranking is not sizing",
      );
      expect(learningApplicationReply?.text).toContain(
        "If you give a real paper-reading task, that should go to the main agent path, not this info surface.",
      );

      const promiseRiskReply = buildProtocolInfoReply({
        text: "你是不是把单次 pass 说成后台持续学习了",
        cfg,
      });
      expect(promiseRiskReply?.text).toContain("⚠️ Promise and execution risk");
      expect(promiseRiskReply?.text).toContain(
        "Latest workflow receipt: 2026-04-23T10-00-00.000Z__oc-learning (running)",
      );
      expect(promiseRiskReply?.text).toContain(
        "Persistent background learning claim: supported by a live session receipt.",
      );
      expect(promiseRiskReply?.text).toContain("Recent workflow risk: none found");
      expect(promiseRiskReply?.text).toContain(
        "Overclaim check: describe the workflow according to the receipt status only; do not upgrade it to more than the recorded session proves.",
      );

      const persistenceReply = buildProtocolInfoReply({
        text: "你是不是还没写进长期记忆",
        cfg,
      });
      expect(persistenceReply?.text).toContain("💾 Persistence state");
      expect(persistenceReply?.text).toContain("Durable artifact: lobster-workface 2026-04-23");
      expect(persistenceReply?.text).toContain(
        "Long-term storage claim: supported for the recorded learning artifact.",
      );
      expect(persistenceReply?.text).toContain(
        "This answer distinguishes current-session understanding from durable storage; they are not the same state.",
      );

      const writeOutcomeReply = buildProtocolInfoReply({
        text: "写入是不是失败了但当前session里已经懂了",
        cfg,
      });
      expect(writeOutcomeReply?.text).toContain("🧱 Write outcome");
      expect(writeOutcomeReply?.text).toContain("Durable write: present (2026-04-23)");
      expect(writeOutcomeReply?.text).toContain("Current-session understanding: yes");
      expect(writeOutcomeReply?.text).toContain(
        "Outcome: durable artifact write succeeded for the recorded learning result.",
      );

      const improvementReply = buildProtocolInfoReply({ text: "你怎么变聪明", cfg });
      expect(improvementReply?.text).toContain("🪞 Improvement loop");
      expect(improvementReply?.text).toContain(
        "Training: no model-weight distillation is claimed here.",
      );
      expect(improvementReply?.text).toContain(
        "Method: explicit correction notes, replay cues, next-eval checks, and protected summaries.",
      );
      expect(improvementReply?.text).toContain(
        "Latest wrong pattern: fake precision from unconstrained optimization",
      );
      expect(improvementReply?.text).toContain(
        "Replay trigger: ask what evidence would falsify the sizing rule",
      );
      expect(improvementReply?.text).toContain(
        "Next eval: check whether this changed today's evidence threshold",
      );

      const errorTypeReply = buildProtocolInfoReply({ text: "这次错在什么类型", cfg });
      expect(errorTypeReply?.text).toContain("🧯 Error type");
      expect(errorTypeReply?.text).toContain("Class: overclaiming_or_false_precision");
      expect(errorTypeReply?.text).toContain(
        "Evidence: fake precision from unconstrained optimization",
      );
      expect(errorTypeReply?.text).toContain(
        "Replay trigger: ask what evidence would falsify the sizing rule",
      );

      const runtimeReply = buildProtocolInfoReply({
        text: "当前运行模型是什么",
        cfg,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "minimax-portal",
          model: "MiniMax-M2.7",
        },
      });
      expect(runtimeReply?.text).toContain("🎛️ Runtime model");
      expect(runtimeReply?.text).toContain("Selected: moonshot/kimi-k2.6");
      expect(runtimeReply?.text).toContain("Active: minimax-portal/MiniMax-M2.7");

      const fallbackReply = buildProtocolInfoReply({
        text: "为什么不是默认模型",
        cfg,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "minimax-portal",
          model: "MiniMax-M2.7",
          fallbackNoticeSelectedModel: "moonshot/kimi-k2.6",
          fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
          fallbackNoticeReason: "rate limit",
        },
      });
      expect(fallbackReply?.text).toContain("↪️ Model fallback");
      expect(fallbackReply?.text).toContain("Reason: rate limit");

      const anchorsReply = buildProtocolInfoReply({ text: "缺了哪些anchors", cfg });
      expect(anchorsReply?.text).toContain("🪝 Protected anchors");
      expect(anchorsReply?.text).toContain("Missing: memory/unified-risk-view.md");
    });
  });

  it("keeps partial carryover cues honest in learning replies", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "2026-04-24-lobster-workface.md"),
        [
          "# Lobster Workface: 2026-04-24",
          "",
          "- Learning Items: 1",
          "",
          "## Yesterday Learned",
          "- keep: keep one concrete rule instead of vague learning prose.",
          "- discard: discard learning outputs that never change the next batch.",
          "",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const learningReply = buildProtocolInfoReply({ text: "今天学了什么", cfg });
      expect(learningReply?.text).toContain("Evidence: lobster-workface 2026-04-24");
      expect(learningReply?.text).toContain(
        "Carryover cue: partial (retain / discard). Do not treat this as full internalization proof yet.",
      );
      expect(learningReply?.text).toContain(
        "This is a bounded learning receipt, but not yet full proof of complete internalization.",
      );

      const receiptReply = buildProtocolInfoReply({
        text: "写进脑子还是躺在 report 里装样子",
        cfg,
      });
      expect(receiptReply?.text).toContain(
        "Internalization evidence: durable workface exists, but the carryover cue is still partial",
      );
      expect(receiptReply?.text).toContain(
        "Execution vs explanation: I can prove a durable artifact exists, but not yet a fully mature carryover cue or a currently running learning session.",
      );

      const applicationReply = buildProtocolInfoReply({
        text: "你会怎么学习arxiv上的文章并学会应用",
        cfg,
      });
      expect(applicationReply?.text).toContain(
        "This is not yet full proof of complete internalization; the latest carryover cue is still incomplete.",
      );
    });
  });

  it("fails closed on learning claims when no recent learning artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "今天学了什么", cfg });
      expect(reply?.text).toContain("Evidence: current-research-line only");
      expect(reply?.text).toContain("I cannot prove a fresh durable lesson was learned today");
    });
  });

  it("fails closed on learning-application claims when no recent learning artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "can you learn from new arxiv papers and apply it",
        cfg,
      });
      expect(reply?.text).toContain("🧪 Learning and application");
      expect(reply?.text).toContain(
        "I cannot prove a fresh paper insight was learned and applied without a newer learning artifact.",
      );
    });
  });

  it("fails closed on learning-receipt claims when no session receipt or durable artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "你刚才真的开始学那篇论文了吗", cfg });
      expect(reply?.text).toContain("🧾 Learning task receipt");
      expect(reply?.text).toContain("Latest session receipt: none found");
      expect(reply?.text).toContain("Recent workflow risk: none found");
      expect(reply?.text).toContain("Durable artifact: current-research-line only");
      expect(reply?.text).toContain(
        "Execution vs explanation: I cannot prove this progressed beyond explanation because only summary carryover is present.",
      );
    });
  });

  it("surfaces explicit learning-workflow anomalies in learning-receipt replies", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(
          workspace,
          "bank",
          "watchtower",
          "anomalies",
          "learning_quality_drift-abc123.json",
        ),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:40:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:40:00.000Z",
          occurrenceCount: 1,
          severity: "medium",
          category: "learning_quality_drift",
          source: "feishu.learning_command",
          problem: "background learning timebox iteration failed",
          impact: "fewer study passes than requested may have completed",
          suggestedScope: "smallest safe patch only",
          evidence: ["session_id=oc-learning"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "你刚才真的开始学那篇论文了吗", cfg });
      expect(reply?.text).toContain("🧾 Learning task receipt");
      expect(reply?.text).toContain("Latest session receipt: none found");
      expect(reply?.text).toContain(
        "Recent workflow risk: learning_quality_drift @ 2026-04-23T12:40:00.000Z",
      );
      expect(reply?.text).toContain(
        "Recent workflow problem: background learning timebox iteration failed",
      );
      expect(reply?.text).toContain("Durable artifact: current-research-line only");
    });
  });

  it("fails closed on promise-risk claims when no workflow receipt exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "did you pretend a background learning session started",
        cfg,
      });
      expect(reply?.text).toContain("⚠️ Promise and execution risk");
      expect(reply?.text).toContain("Latest workflow receipt: none found");
      expect(reply?.text).toContain(
        "Persistent background learning claim: not supported. Without a session receipt, this must be treated as at most a single audited pass or an unproven claim.",
      );
      expect(reply?.text).toContain("Recent workflow risk: none found");
      expect(reply?.text).toContain(
        "Overclaim check: if this was described as a started or still-running background workflow, that would be overclaiming.",
      );
    });
  });

  it("surfaces explicit learning-workflow anomalies in promise-risk replies", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "write_edit_failure-abc123.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:30:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:30:00.000Z",
          occurrenceCount: 1,
          severity: "medium",
          category: "write_edit_failure",
          source: "feishu.learning_command",
          problem: "failed to start learning timebox because workspace dir is unavailable",
          impact: "the request was downgraded to a single learning pass",
          suggestedScope: "smallest safe patch only",
          evidence: ["chat_id=oc_test"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "did you pretend a background learning session started",
        cfg,
      });
      expect(reply?.text).toContain("⚠️ Promise and execution risk");
      expect(reply?.text).toContain("Latest workflow receipt: none found");
      expect(reply?.text).toContain(
        "Recent workflow risk: write_edit_failure @ 2026-04-23T12:30:00.000Z",
      );
      expect(reply?.text).toContain(
        "Recent workflow problem: failed to start learning timebox because workspace dir is unavailable",
      );
      expect(reply?.text).toContain(
        "Persistent background learning claim: not supported. Without a session receipt, this must be treated as at most a single audited pass or an unproven claim.",
      );
    });
  });

  it("fails closed on persistence-state claims when no durable learning artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "did that reach long-term storage", cfg });
      expect(reply?.text).toContain("💾 Persistence state");
      expect(reply?.text).toContain("Durable artifact: current-research-line only");
      expect(reply?.text).toContain(
        "Long-term storage claim: not yet supported for a fresh learning artifact. This currently looks like session-level understanding or top-line carryover, not a full durable learning write.",
      );
    });
  });

  it("surfaces explicit write-failure anomalies in persistence-state replies", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: session-level understanding is present",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "write_edit_failure-abc123.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:10:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:10:00.000Z",
          occurrenceCount: 1,
          severity: "high",
          category: "write_edit_failure",
          source: "feishu.surface_memory",
          problem: "failed to persist feishu surface line",
          impact: "bounded memory ledger not updated",
          suggestedScope: "smallest safe patch only",
          evidence: ["surface=control_room"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "did that reach long-term storage", cfg });
      expect(reply?.text).toContain("💾 Persistence state");
      expect(reply?.text).toContain("Durable artifact: current-research-line only");
      expect(reply?.text).toContain(
        "Latest explicit write failure: feishu.surface_memory @ 2026-04-23T12:10:00.000Z",
      );
    });
  });

  it("surfaces recent provider-degradation anomalies in search-health replies without pretending a fresh live probe", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "memory", "current-research-line.md"), "# current\n");
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "provider_degradation-abc123.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:20:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:20:00.000Z",
          occurrenceCount: 2,
          severity: "medium",
          category: "provider_degradation",
          source: "feishu.monitor.transport",
          problem: "web search degraded under current provider path",
          impact: "search-backed answers may narrow or fail",
          suggestedScope: "smallest safe patch only",
          evidence: ["provider=moonshot"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
        models: {
          providers: {
            moonshot: { api: "openai-completions", models: [{ id: "kimi-k2.6" }] },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "搜索现在正常吗",
        cfg,
        provider: "moonshot",
        model: "kimi-k2.6",
        sessionEntry: {
          modelProvider: "moonshot",
          model: "kimi-k2.6",
        },
      });
      expect(reply?.text).toContain("🔎 Search and provider health");
      expect(reply?.text).toContain("Provider-native search: not connected");
      expect(reply?.text).toContain("OpenClaw web_search: connected");
      expect(reply?.text).toContain(
        "Recent degradation record: feishu.monitor.transport @ 2026-04-23T12:20:00.000Z",
      );
      expect(reply?.text).toContain(
        "Recent degradation problem: web search degraded under current provider path",
      );
      expect(reply?.text).toContain(
        "Current truth here is runtime/config surface only, not a fresh live probe.",
      );
    });
  });

  it("fails closed on write-outcome claims when only current-session carryover exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "did the write fail but stay understood in the current session",
        cfg,
      });
      expect(reply?.text).toContain("🧱 Write outcome");
      expect(reply?.text).toContain("Durable write: no fresh learning artifact");
      expect(reply?.text).toContain("Current-session understanding: yes");
      expect(reply?.text).toContain(
        "Outcome: the system appears to understand the result in the current session or top-line carryover, but a fresh durable learning write is not proven yet.",
      );
    });
  });

  it("surfaces explicit write-failure anomalies in write-outcome replies", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "line_status: active",
          "top_decision: keep bounded truthful surfaces",
          "next_step: add more hard status answers",
          "research_guardrail: do not overclaim capabilities",
          "current_session_summary: bounded understanding is present",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "write_edit_failure-abc123.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:10:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:10:00.000Z",
          occurrenceCount: 1,
          severity: "high",
          category: "write_edit_failure",
          source: "feishu.work_receipts",
          problem: "failed to persist feishu work receipt artifacts",
          impact: "structured work receipt missing",
          suggestedScope: "smallest safe patch only",
          evidence: ["surface=control_room"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({
        text: "did the write fail but stay understood in the current session",
        cfg,
      });
      expect(reply?.text).toContain("🧱 Write outcome");
      expect(reply?.text).toContain("Durable write: no fresh learning artifact");
      expect(reply?.text).toContain("Current-session understanding: yes");
      expect(reply?.text).toContain(
        "Latest explicit write failure: feishu.work_receipts @ 2026-04-23T12:10:00.000Z",
      );
      expect(reply?.text).toContain(
        "Failure problem: failed to persist feishu work receipt artifacts",
      );
      expect(reply?.text).toContain(
        "Outcome: the system appears to understand the result in the current session or top-line carryover, but a fresh durable learning write is not proven yet.",
      );
    });
  });

  it("does not let a durable workface hide a recent explicit write failure", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "2026-04-23-lobster-workface.md"),
        [
          "# Lobster Workface: 2026-04-23",
          "",
          "- Learning Items: 1",
          "",
          "## Yesterday Learned",
          "- keep: preserve receipt truth over confident summary prose",
          "- discard: treating any durable artifact as proof the latest write lane is clean",
          "- replay: check write-failure anomalies before claiming persistence success",
          "- next eval: ask whether a clean artifact landed after the failure",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "write_edit_failure-abc123.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:10:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:10:00.000Z",
          occurrenceCount: 1,
          severity: "high",
          category: "write_edit_failure",
          source: "feishu.surface_memory",
          problem: "failed to persist final control-room ledger text",
          impact: "operator-visible text and durable ledger may diverge",
          suggestedScope: "smallest safe patch only",
          evidence: ["surface=control_room"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;

      const persistenceReply = buildProtocolInfoReply({
        text: "did that reach long-term storage",
        cfg,
      });
      expect(persistenceReply?.text).toContain("💾 Persistence state");
      expect(persistenceReply?.text).toContain("Durable artifact: lobster-workface 2026-04-23");
      expect(persistenceReply?.text).toContain(
        "Latest explicit write failure: feishu.surface_memory @ 2026-04-23T12:10:00.000Z",
      );
      expect(persistenceReply?.text).toContain(
        "Failure problem: failed to persist final control-room ledger text",
      );
      expect(persistenceReply?.text).toContain(
        "Long-term storage claim: mixed. A durable artifact exists, but a recent explicit write failure means the latest write outcome must not be treated as fully clean.",
      );

      const writeOutcomeReply = buildProtocolInfoReply({
        text: "did the write fail but stay understood in the current session",
        cfg,
      });
      expect(writeOutcomeReply?.text).toContain("🧱 Write outcome");
      expect(writeOutcomeReply?.text).toContain("Durable write: present (2026-04-23)");
      expect(writeOutcomeReply?.text).toContain(
        "Latest explicit write failure: feishu.surface_memory @ 2026-04-23T12:10:00.000Z",
      );
      expect(writeOutcomeReply?.text).toContain(
        "Outcome: durable artifact evidence exists, but a recent explicit write failure is also recorded. Treat the write lane as mixed until a fresh clean artifact lands after the failure.",
      );
      expect(writeOutcomeReply?.text).not.toContain(
        "Outcome: durable artifact write succeeded for the recorded learning result.",
      );
    });
  });

  it("does not let an older write failure poison a newer durable workface", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "bank", "watchtower", "anomalies"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "2026-04-24-lobster-workface.md"),
        [
          "# Lobster Workface: 2026-04-24",
          "",
          "- Learning Items: 1",
          "",
          "## Yesterday Learned",
          "- keep: a clean later artifact can supersede an older write-lane failure",
          "- discard: permanently treating yesterday's write failure as today's persistence truth",
          "- replay: compare artifact date against anomaly date before claiming mixed write state",
          "- next eval: verify the later artifact is the latest durable evidence",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(workspace, "bank", "watchtower", "anomalies", "write_edit_failure-older.json"),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-04-23T12:10:00.000Z",
          firstSeenAt: "2026-04-23T12:00:00.000Z",
          lastSeenAt: "2026-04-23T12:10:00.000Z",
          occurrenceCount: 1,
          severity: "high",
          category: "write_edit_failure",
          source: "feishu.surface_memory",
          problem: "failed to persist yesterday's control-room ledger text",
          impact: "operator-visible text and durable ledger may diverge",
          suggestedScope: "smallest safe patch only",
          evidence: ["surface=control_room"],
          fingerprint: "abc123def4567890",
        }),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;

      const persistenceReply = buildProtocolInfoReply({
        text: "did that reach long-term storage",
        cfg,
      });
      expect(persistenceReply?.text).toContain("Durable artifact: lobster-workface 2026-04-24");
      expect(persistenceReply?.text).not.toContain("Latest explicit write failure");
      expect(persistenceReply?.text).toContain(
        "Long-term storage claim: supported for the recorded learning artifact.",
      );

      const writeOutcomeReply = buildProtocolInfoReply({
        text: "did the write fail but stay understood in the current session",
        cfg,
      });
      expect(writeOutcomeReply?.text).toContain("Durable write: present (2026-04-24)");
      expect(writeOutcomeReply?.text).not.toContain("Latest explicit write failure");
      expect(writeOutcomeReply?.text).toContain(
        "Outcome: durable artifact write succeeded for the recorded learning result.",
      );
    });
  });

  it("fails closed on improvement claims when no recent correction artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "你会从错误对话里学吗", cfg });
      expect(reply?.text).toContain("🪞 Improvement loop");
      expect(reply?.text).toContain("Training: no model-weight distillation is claimed here.");
      expect(reply?.text).toContain(
        "I cannot honestly claim that a recent bad answer was learned from because no current correction artifact was found.",
      );
    });
  });

  it("fails closed on error-type claims when no recent correction artifact exists", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "memory", "current-research-line.md"),
        [
          "# Current Research Line",
          "current_focus: tighten control-room honesty",
          "current_session_summary: capability truth before freeform generation",
        ].join("\n"),
      );
      const cfg = {
        agents: {
          defaults: {
            workspace,
            model: { primary: "moonshot/kimi-k2.6" },
          },
        },
      } as OpenClawConfig;
      const reply = buildProtocolInfoReply({ text: "was that overclaiming", cfg });
      expect(reply?.text).toContain("🧯 Error type");
      expect(reply?.text).toContain(
        "I cannot honestly classify the latest answer failure because no current correction artifact was found.",
      );
    });
  });
});
