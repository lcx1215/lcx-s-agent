import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySkillOptAutoCueToBody, resolveSkillOptAutoCue } from "./skillopt-autocue.js";

async function writeBestSkill(workspaceDir: string, skillId: string, body: string) {
  const target = path.join(workspaceDir, "memory", "skillopt-lite", skillId, "best_skill.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf8");
  return target;
}

describe("resolveSkillOptAutoCue", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skillopt-autocue-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("injects finance data provenance SOPs from SkillOpt workspace memory", async () => {
    const bestSkillPath = await writeBestSkill(
      workspaceDir,
      "finance_data_provenance_preflight",
      [
        "# Finance data provenance preflight",
        "",
        "- Require source timestamp, unit, currency, adjusted status, and provider role.",
        "- Stop conflicted values before answer synthesis.",
      ].join("\n"),
    );

    const cue = await resolveSkillOptAutoCue({
      body: "帮我看一下 NVDA 最新价格和供应商数据口径冲突",
      workspaceDir,
      includeDefaultWorkspace: false,
    });

    expect(cue?.matchedSkillIds).toEqual(["finance_data_provenance_preflight"]);
    expect(cue?.bestSkillPaths).toEqual([bestSkillPath]);
    expect(cue?.promptInjection).toContain("source timestamp");
    expect(cue?.promptInjection).toContain("Do not expose SkillOpt labels");
    expect(cue?.liveTouched).toBe(false);
    expect(cue?.providerConfigTouched).toBe(false);
    expect(cue?.protectedMemoryTouched).toBe(false);
  });

  it("can match LiveLark sync requests and keep the preflight as boundary-only", async () => {
    await writeBestSkill(
      workspaceDir,
      "live_lark_boundary_preflight",
      [
        "# Live Lark boundary preflight",
        "",
        "- Syncing source to the live sidecar is not live-user-seen.",
        "- Fresh real Lark inbound/outbound evidence is required before claiming visible fixed.",
      ].join("\n"),
    );

    const cue = await resolveSkillOptAutoCue({
      body: "我说连接 LiveLark 是希望 live仓直接用训练进化，不要以后手动搬格式",
      workspaceDir,
      includeDefaultWorkspace: false,
    });

    expect(cue?.matchedSkillIds).toEqual(["live_lark_boundary_preflight"]);
    expect(cue?.promptInjection).toContain("live-user-seen");
    expect(cue?.boundary).toBe("dev_skillopt_preflight_only");
  });

  it("does not inject a matched skill when no accepted best_skill.md exists", async () => {
    const cue = await resolveSkillOptAutoCue({
      body: "帮我看一下 NVDA 最新价格",
      workspaceDir,
      includeDefaultWorkspace: false,
    });

    expect(cue).toBeNull();
  });

  it("wraps the original request after the SkillOpt preflight", async () => {
    await writeBestSkill(
      workspaceDir,
      "module_learning_absorption_preflight",
      "# Module learning absorption preflight\n\n- Require eval or training absorption proof.",
    );
    const cue = await resolveSkillOptAutoCue({
      body: "证明这个 skill 被模型全种吸收了",
      workspaceDir,
      includeDefaultWorkspace: false,
    });

    const body = applySkillOptAutoCueToBody({
      body: "证明这个 skill 被模型全种吸收了",
      cue,
    });

    expect(body).toContain("[SkillOpt-lite runtime preflight - deterministic]");
    expect(body).toContain("Require eval or training absorption proof");
    expect(body).toContain("[Original user request after SkillOpt-lite preflight]");
  });
});
