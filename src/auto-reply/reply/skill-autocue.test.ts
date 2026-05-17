import { describe, expect, it } from "vitest";
import { applySkillAutoCueToBody, resolveSkillAutoCue } from "./skill-autocue.js";

const coreSkills = [
  "agent-brain-eval",
  "cli-anything-harvester",
  "lcx-qwen-training-operator",
  "lcx-workflow-waterflow-auditor",
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
      body: "检查 qwen 训练 guard PID 和最新 adapter promotion truth",
      availableSkillNames: coreSkills,
    });

    expect(cue?.skillName).toBe("lcx-qwen-training-operator");
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
