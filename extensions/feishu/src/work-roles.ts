import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../../../src/infra/fs-safe.js";
import { resolveToolsConfig } from "./tools-config.js";

const WORK_ROLE_ACTION_VALUES = ["list", "add", "remove", "reset"] as const;
const WORK_ROLE_STATUS_VALUES = ["active", "disabled"] as const;

export const FEISHU_WORK_ROLE_REGISTRY_PATH = "memory/feishu-work-roles.json";

export type FeishuWorkRole = {
  id: string;
  displayName: string;
  title: string;
  responsibility: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type FeishuWorkRoleRegistry = {
  version: 1;
  updatedAt: string;
  primaryBrain: {
    id: "control_room";
    invariant: "single_primary_brain";
  };
  learningSystem: {
    id: "unified_learning_system";
    invariant: "single_learning_system";
  };
  roles: FeishuWorkRole[];
};

export const FeishuWorkRoleSchema = Type.Object({
  action: Type.Unsafe<(typeof WORK_ROLE_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...WORK_ROLE_ACTION_VALUES],
    description: "Action to run: list | add | remove | reset",
  }),
  roleId: Type.Optional(Type.String({ description: "Stable role id for add/remove" })),
  displayName: Type.Optional(Type.String({ description: "Visible Lark role name, e.g. 小明" })),
  title: Type.Optional(Type.String({ description: "Short role title, e.g. 研究员" })),
  responsibility: Type.Optional(Type.String({ description: "What this work role should do" })),
  status: Type.Optional(
    Type.Unsafe<(typeof WORK_ROLE_STATUS_VALUES)[number]>({
      type: "string",
      enum: [...WORK_ROLE_STATUS_VALUES],
      description: "Role status for add; defaults to active",
    }),
  ),
});

export type FeishuWorkRoleParams = Static<typeof FeishuWorkRoleSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function deriveRoleId(displayName: string): string {
  const ascii = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (ascii) {
    return ascii;
  }
  return `role-${Buffer.from(displayName).toString("hex").slice(0, 16)}`;
}

function defaultWorkRoleRegistry(at = nowIso()): FeishuWorkRoleRegistry {
  const seed = [
    ["xiaoming", "小明", "研究员", "资料收集、来源筛选、把可学习材料压成证据和候选经验。"],
    ["xiaoli", "小李", "策略员", "ETF、因子、择时、组合逻辑和低频研究框架拆解。"],
    ["xiaowang", "小王", "风控员", "过拟合、样本外、回撤、仓位、失效条件和执行边界审查。"],
    [
      "xiaomei",
      "小美",
      "记忆员",
      "把高价值结果沉淀为 artifact、correction note、doctrine 候选和后续复盘线索。",
    ],
    [
      "xiaozhao",
      "小赵",
      "运维员",
      "检查任务状态、失败原因、Lark 回复、队列、日志和 dev/live 边界。",
    ],
  ] as const;
  return {
    version: 1,
    updatedAt: at,
    primaryBrain: {
      id: "control_room",
      invariant: "single_primary_brain",
    },
    learningSystem: {
      id: "unified_learning_system",
      invariant: "single_learning_system",
    },
    roles: seed.map(([id, displayName, title, responsibility]) => ({
      id,
      displayName,
      title,
      responsibility,
      status: "active",
      createdAt: at,
      updatedAt: at,
    })),
  };
}

function coerceRegistry(value: unknown): FeishuWorkRoleRegistry | undefined {
  const candidate = value as Partial<FeishuWorkRoleRegistry>;
  if (candidate.version !== 1 || !Array.isArray(candidate.roles)) {
    return undefined;
  }
  return {
    version: 1,
    updatedAt: normalizeText(candidate.updatedAt) || nowIso(),
    primaryBrain: {
      id: "control_room",
      invariant: "single_primary_brain",
    },
    learningSystem: {
      id: "unified_learning_system",
      invariant: "single_learning_system",
    },
    roles: candidate.roles
      .map((role) => {
        const raw = role as Partial<FeishuWorkRole>;
        const displayName = normalizeText(raw.displayName);
        const title = normalizeText(raw.title);
        const responsibility = normalizeText(raw.responsibility);
        if (!displayName || !title || !responsibility) {
          return null;
        }
        return {
          id: normalizeText(raw.id) || deriveRoleId(displayName),
          displayName,
          title,
          responsibility,
          status: raw.status === "disabled" ? "disabled" : "active",
          createdAt: normalizeText(raw.createdAt) || nowIso(),
          updatedAt: normalizeText(raw.updatedAt) || nowIso(),
        } satisfies FeishuWorkRole;
      })
      .filter((role): role is FeishuWorkRole => Boolean(role)),
  };
}

export async function loadFeishuWorkRoleRegistry(
  workspaceDir: string,
): Promise<FeishuWorkRoleRegistry> {
  try {
    const raw = await readFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: FEISHU_WORK_ROLE_REGISTRY_PATH,
    });
    const parsed = coerceRegistry(JSON.parse(raw.buffer.toString("utf-8")));
    return parsed ?? defaultWorkRoleRegistry();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code !== "ENOENT" && code !== "not-found") {
      throw error;
    }
    return defaultWorkRoleRegistry();
  }
}

async function saveFeishuWorkRoleRegistry(params: {
  workspaceDir: string;
  registry: FeishuWorkRoleRegistry;
}): Promise<void> {
  await fs.mkdir(path.join(params.workspaceDir, "memory"), { recursive: true });
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: FEISHU_WORK_ROLE_REGISTRY_PATH,
    data: `${JSON.stringify(params.registry, null, 2)}\n`,
  });
}

function activeRoles(registry: FeishuWorkRoleRegistry): FeishuWorkRole[] {
  return registry.roles.filter((role) => role.status === "active");
}

function renderRegistryReply(params: {
  action: FeishuWorkRoleParams["action"];
  registry: FeishuWorkRoleRegistry;
  changed: boolean;
  note?: string;
}): string {
  const roleLines = activeRoles(params.registry).map(
    (role) => `- ${role.displayName}｜${role.title}: ${role.responsibility}`,
  );
  return [
    params.changed
      ? `已更新 Lark 分工角色：${params.action}。`
      : `Lark 分工角色未变更：${params.action}。`,
    params.note,
    "边界：主大脑仍是一个 control_room；学习系统仍是一套 unified_learning_system；这些角色只是可增删的展示/分工工位。",
    "当前 active roles:",
    ...(roleLines.length > 0 ? roleLines : ["- 暂无 active role；请新增角色后再展示分工面板。"]),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function applyFeishuWorkRoleAction(params: {
  workspaceDir: string;
  action: FeishuWorkRoleParams["action"];
  roleId?: string;
  displayName?: string;
  title?: string;
  responsibility?: string;
  status?: "active" | "disabled";
}): Promise<{
  changed: boolean;
  registry: FeishuWorkRoleRegistry;
  replyText: string;
  path: string;
}> {
  const registry = await loadFeishuWorkRoleRegistry(params.workspaceDir);
  let changed = false;
  let note: string | undefined;
  const at = nowIso();

  if (params.action === "reset") {
    const reset = defaultWorkRoleRegistry(at);
    await saveFeishuWorkRoleRegistry({ workspaceDir: params.workspaceDir, registry: reset });
    return {
      changed: true,
      registry: reset,
      replyText: renderRegistryReply({ action: params.action, registry: reset, changed: true }),
      path: FEISHU_WORK_ROLE_REGISTRY_PATH,
    };
  }

  if (params.action === "add") {
    const displayName = normalizeText(params.displayName);
    const title = normalizeText(params.title) || "协作角色";
    const responsibility = normalizeText(params.responsibility);
    if (!displayName || !responsibility) {
      throw new Error("displayName and responsibility are required for add");
    }
    const roleId = normalizeText(params.roleId) || deriveRoleId(displayName);
    const existing = registry.roles.find(
      (role) => role.id === roleId || role.displayName === displayName,
    );
    if (existing) {
      existing.displayName = displayName;
      existing.title = title;
      existing.responsibility = responsibility;
      existing.status = params.status ?? "active";
      existing.updatedAt = at;
      note = `已更新已有角色 ${displayName}。`;
    } else {
      registry.roles.push({
        id: roleId,
        displayName,
        title,
        responsibility,
        status: params.status ?? "active",
        createdAt: at,
        updatedAt: at,
      });
      note = `已新增角色 ${displayName}。`;
    }
    changed = true;
  }

  if (params.action === "remove") {
    const roleId = normalizeText(params.roleId);
    const displayName = normalizeText(params.displayName);
    if (!roleId && !displayName) {
      throw new Error("roleId or displayName is required for remove");
    }
    const existing = registry.roles.find(
      (role) => (roleId && role.id === roleId) || (displayName && role.displayName === displayName),
    );
    if (existing && existing.status !== "disabled") {
      existing.status = "disabled";
      existing.updatedAt = at;
      changed = true;
      note = `已停用角色 ${existing.displayName}。`;
    } else {
      note = "没有找到可停用的 active 角色。";
    }
  }

  if (changed) {
    registry.updatedAt = at;
    await saveFeishuWorkRoleRegistry({ workspaceDir: params.workspaceDir, registry });
  }

  return {
    changed,
    registry,
    replyText: renderRegistryReply({ action: params.action, registry, changed, note }),
    path: FEISHU_WORK_ROLE_REGISTRY_PATH,
  };
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerFeishuWorkRoleTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_work_roles: No config available, skipping work-role tools");
    return;
  }

  const cfg = api.config as OpenClawConfig;
  const feishuCfg = cfg.channels?.feishu;
  const toolsCfg = resolveToolsConfig(feishuCfg?.tools);
  if (!toolsCfg.workRoles) {
    api.logger.debug?.("feishu_work_roles: work-role tool disabled in config");
    return;
  }

  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  api.registerTool(
    {
      name: "feishu_work_roles",
      label: "Feishu Work Roles",
      description:
        "Manage visible Lark work-role lanes such as 小明/小李/小王. Actions: list, add, remove, reset. This changes role display/work division only; it never creates another primary brain or learning system.",
      parameters: FeishuWorkRoleSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuWorkRoleParams;
        try {
          const result = await applyFeishuWorkRoleAction({
            workspaceDir,
            action: p.action,
            roleId: p.roleId,
            displayName: p.displayName,
            title: p.title,
            responsibility: p.responsibility,
            status: p.status,
          });
          return json(result);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    { name: "feishu_work_roles" },
  );

  api.logger.info?.("feishu_work_roles: Registered feishu_work_roles tool");
}
