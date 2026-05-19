import { describe, expect, it } from "vitest";
import { applySkillAutoCueToBody, resolveSkillAutoCue } from "./skill-autocue.js";

const coreSkills = [
  "agent-brain-eval",
  "cli-anything-harvester",
  "lcx-commercial-answer-pipeline-operator",
  "lcx-module-learning-absorption-operator",
  "lcx-promotion-and-adapter-truth-operator",
  "lcx-qwen-training-operator",
  "lcx-workflow-waterflow-auditor",
  "skill-harvester",
];

describe("resolveSkillAutoCue", () => {
  it("selects cli-anything-harvester for natural-language CLI-Anything requests", () => {
    const cue = resolveSkillAutoCue({
      body: "香港大学 CLI-Anything 可以把本地软件 CLI 化吗，演示一下",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("cli-anything-harvester");
  });

  it("selects agent-brain-eval when the user asks whether the agent really used skills", () => {
    const cue = resolveSkillAutoCue({
      body: "本地智能体真的会用这些skills吗，确保它能用会用真的用了",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("agent-brain-eval");
  });

  it("selects the Qwen operator for local-brain training supervision requests", () => {
    const cue = resolveSkillAutoCue({
      body: "检查 qwen 训练 guard PID 和最新训练状态",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-qwen-training-operator");
  });

  it("selects the adapter truth operator for promotion and parseRecovered requests", () => {
    const cue = resolveSkillAutoCue({
      body: "检查最新 adapter promotion truth 和 parseRecovered 是否阻塞晋级",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-promotion-and-adapter-truth-operator");
  });

  it("selects module learning absorption operator for source-learning internalization", () => {
    const cue = resolveSkillAutoCue({
      body: "把网上学习到的采访和博客沉淀到模块，确认不是 stored-only",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-module-learning-absorption-operator");
  });

  it("selects commercial answer pipeline operator for bounded visible reply review", () => {
    const cue = resolveSkillAutoCue({
      body: "商用回答流水线要避免模型答案直接当最终答案，并输出 failed reason",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-commercial-answer-pipeline-operator");
  });

  it("selects workflow waterflow auditor for self-healing precision-machine architecture asks", () => {
    const cue = resolveSkillAutoCue({
      body: "我想让整个系统像精密仪器一样环环相扣，快照旧了能自动更新，出错后能自动修复",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-workflow-waterflow-auditor");
  });

  it("selects skill harvester for the five external agent architecture families", () => {
    const cue = resolveSkillAutoCue({
      body: "把 Agent Lightning、LongMemEval、LightMem、ClawBench 这五个架构继续巩固融入智能体",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("skill-harvester");
  });

  it("does not select a skill that is not available in the current snapshot", () => {
    const cue = resolveSkillAutoCue({
      body: "香港大学 CLI-Anything 可以把本地软件 CLI 化吗",
      availableSkillNames: ["agent-brain-eval"],
    });

    expect(cue).toBeNull();
  });

  it("does not override explicit slash skill commands", () => {
    const cue = resolveSkillAutoCue({
      body: "/skill agent-brain-eval 看看本地智能体是否学会",
      availableSkillNames: coreSkills,
    });

    expect(cue).toBeNull();
  });

  it("wraps the body with a deterministic use-skill cue and usage receipt requirement", () => {
    const body = applySkillAutoCueToBody({
      body: "本地智能体真的会用这些skills吗",
      cue: {
        skillName: "agent-brain-eval",
        reason: "the request asks whether the agent learned",
      },
    });

    expect(body).toContain("Matched skill: agent-brain-eval");
    expect(body).toContain('Use the "agent-brain-eval" skill for this request');
    expect(body).toContain("Leave a concise usage receipt");
    expect(body).toContain("[Original user request]");
  });
});
