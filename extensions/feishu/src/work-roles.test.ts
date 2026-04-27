import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FEISHU_WORK_ROLE_REGISTRY_PATH,
  applyFeishuWorkRoleAction,
  loadFeishuWorkRoleRegistry,
} from "./work-roles.js";

describe("feishu work roles", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-work-roles-"));
  });

  it("starts with visible role lanes while preserving one brain and one learning system", async () => {
    const registry = await loadFeishuWorkRoleRegistry(workspaceDir);

    expect(registry.primaryBrain).toEqual({
      id: "control_room",
      invariant: "single_primary_brain",
    });
    expect(registry.learningSystem).toEqual({
      id: "unified_learning_system",
      invariant: "single_learning_system",
    });
    expect(registry.roles.map((role) => role.displayName)).toEqual([
      "小明",
      "小李",
      "小王",
      "小美",
      "小赵",
    ]);
  });

  it("adds and updates a visible Lark work role without creating another brain", async () => {
    const added = await applyFeishuWorkRoleAction({
      workspaceDir,
      action: "add",
      displayName: "小陈",
      title: "宏观员",
      responsibility: "看宏观、利率和风险传导。",
    });

    expect(added.changed).toBe(true);
    expect(added.path).toBe(FEISHU_WORK_ROLE_REGISTRY_PATH);
    expect(added.replyText).toContain("主大脑仍是一个 control_room");
    expect(added.replyText).toContain("小陈｜宏观员");

    const updated = await applyFeishuWorkRoleAction({
      workspaceDir,
      action: "add",
      displayName: "小陈",
      title: "宏观研究员",
      responsibility: "只看宏观、利率、美元和风险传导。",
    });

    expect(updated.registry.roles.filter((role) => role.displayName === "小陈")).toHaveLength(1);
    expect(updated.replyText).toContain("小陈｜宏观研究员");
    expect(updated.registry.primaryBrain.invariant).toBe("single_primary_brain");
    expect(updated.registry.learningSystem.invariant).toBe("single_learning_system");
  });

  it("removes a visible role by disabling it instead of touching shared systems", async () => {
    const removed = await applyFeishuWorkRoleAction({
      workspaceDir,
      action: "remove",
      displayName: "小李",
    });

    expect(removed.changed).toBe(true);
    expect(removed.registry.roles.find((role) => role.displayName === "小李")?.status).toBe(
      "disabled",
    );
    expect(removed.replyText).not.toContain("小李｜策略员");
    expect(removed.registry.primaryBrain.id).toBe("control_room");
    expect(removed.registry.learningSystem.id).toBe("unified_learning_system");
  });
});
