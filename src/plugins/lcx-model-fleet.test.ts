import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import fleet from "./lcx-model-fleet.js";
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("LCX model fleet plugin", () => {
  it("creates research tools with the calling agent workspace", async () => {
    const registrations: Array<AnyAgentTool | OpenClawPluginToolFactory> = [];
    const api = {
      config: {},
      pluginConfig: {
        slotModels: {
          fast: "provider/fast",
          reasoning: "provider/fast",
          review: "review/model",
        },
      },
      registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory) => registrations.push(tool),
      on: () => undefined,
      registerService: () => undefined,
    } as unknown as OpenClawPluginApi;

    fleet.register?.(api);
    const researchFactory = registrations[1];
    expect(typeof researchFactory).toBe("function");

    const firstWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-fleet-agent-a-"));
    const secondWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-fleet-agent-b-"));
    roots.push(firstWorkspace, secondWorkspace);
    const firstTool = (researchFactory as OpenClawPluginToolFactory)({
      workspaceDir: firstWorkspace,
      config: {},
    });
    const secondTool = (researchFactory as OpenClawPluginToolFactory)({
      workspaceDir: secondWorkspace,
      config: {},
    });
    expect(firstTool && !Array.isArray(firstTool) ? firstTool.name : undefined).toBe(
      "finance_research_run",
    );
    expect(secondTool && !Array.isArray(secondTool) ? secondTool.name : undefined).toBe(
      "finance_research_run",
    );

    const input = {
      ask: "只规划：列出收入下降时缺失的证据",
      asOf: "2026-09-11T00:00:00Z",
      live: false,
    };
    const firstResult = await (firstTool as AnyAgentTool).execute("fleet-a", input);
    const secondResult = await (secondTool as AnyAgentTool).execute("fleet-b", input);
    expect((firstResult.details as { receiptPath: string }).receiptPath).toContain(
      path.join(firstWorkspace, "state"),
    );
    expect((secondResult.details as { receiptPath: string }).receiptPath).toContain(
      path.join(secondWorkspace, "state"),
    );
  });
});
