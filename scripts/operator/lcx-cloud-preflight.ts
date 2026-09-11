#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  id: string;
  status: CheckStatus;
  detail: string;
};

const CLOUD_PREFLIGHT_SCHEMA = "lcx_cloud_preflight_v1" as const;

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function hasConfiguredSecret(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(
    normalized &&
    !normalized.includes("replace_with") &&
    !["changeme", "change-me", "placeholder"].includes(normalized),
  );
}

function absolutePath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && path.isAbsolute(normalized) ? path.resolve(normalized) : undefined;
}

function pathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writableDirectory(value: string): Promise<boolean> {
  try {
    const stat = await fs.stat(value);
    if (!stat.isDirectory()) {
      return false;
    }
    await fs.access(value, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function configMentionsLocalVision(configPath: string | undefined): Promise<boolean> {
  if (!configPath) {
    return false;
  }
  try {
    const contents = await fs.readFile(configPath, "utf8");
    return contents.includes("mlx-vlm/local");
  } catch {
    return false;
  }
}

function checkLocalVisionCloudBoundary(env: NodeJS.ProcessEnv): Check {
  const enabled = isTruthy(env.LCX_LOCAL_VISION_ENABLED);
  if (!enabled) {
    return {
      id: "cloud_local_vision_boundary",
      status: "pass",
      detail: "Apple-only MLX local vision is disabled for this cloud runtime.",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      id: "cloud_local_vision_boundary",
      status: "warn",
      detail:
        "MLX is enabled on Apple Silicon; use this only for a local runtime, not the cloud profile.",
    };
  }
  return {
    id: "cloud_local_vision_boundary",
    status: "fail",
    detail:
      "LCX_LOCAL_VISION_ENABLED is set on a non-Apple runtime; configure a hosted or GPU vision model instead.",
  };
}

export async function buildCloudPreflight(env: NodeJS.ProcessEnv = process.env) {
  const stateDir = absolutePath(env.OPENCLAW_STATE_DIR);
  const configPath = absolutePath(env.OPENCLAW_CONFIG_PATH);
  const checks: Check[] = [];

  checks.push(
    isTruthy(env.LCX_CLOUD_RUNTIME)
      ? {
          id: "cloud_runtime_declared",
          status: "pass",
          detail: "LCX_CLOUD_RUNTIME is enabled.",
        }
      : {
          id: "cloud_runtime_declared",
          status: "warn",
          detail:
            "LCX_CLOUD_RUNTIME is not enabled; the process may still be a local/container test.",
        },
  );

  if (!stateDir) {
    checks.push({
      id: "canonical_state_root",
      status: "fail",
      detail: "OPENCLAW_STATE_DIR must be an absolute path in the cloud runtime.",
    });
  } else {
    checks.push({
      id: "canonical_state_root",
      status: "pass",
      detail: `Single canonical state root: ${stateDir}`,
    });
    const writable = await writableDirectory(stateDir);
    checks.push({
      id: "state_root_writable",
      status: writable ? "pass" : "fail",
      detail: writable
        ? "State root exists and is writable."
        : "State root is missing, not a directory, or not writable.",
    });
  }

  if (!configPath) {
    checks.push({
      id: "config_path",
      status: "fail",
      detail: "OPENCLAW_CONFIG_PATH must be an absolute path in the cloud runtime.",
    });
  } else if (stateDir && !pathWithin(stateDir, configPath)) {
    checks.push({
      id: "config_path",
      status: "fail",
      detail:
        "OPENCLAW_CONFIG_PATH is outside OPENCLAW_STATE_DIR; this would create split-brain state.",
    });
  } else {
    checks.push({
      id: "config_path",
      status: "pass",
      detail: `Config path is inside the canonical state root: ${configPath}`,
    });
  }

  const configDir = absolutePath(env.OPENCLAW_CONFIG_DIR);
  const workspaceDir = absolutePath(env.OPENCLAW_WORKSPACE_DIR);
  const workspaceIsNestedInConfig =
    configDir !== undefined && workspaceDir !== undefined && pathWithin(configDir, workspaceDir);
  const configDirOutsideState =
    stateDir !== undefined && configDir !== undefined && !pathWithin(stateDir, configDir);
  const workspaceDirOutsideState =
    stateDir !== undefined && workspaceDir !== undefined && !pathWithin(stateDir, workspaceDir);
  if (configDirOutsideState || workspaceDirOutsideState) {
    checks.push({
      id: "compose_mounts",
      status: "fail",
      detail:
        "OPENCLAW_CONFIG_DIR and OPENCLAW_WORKSPACE_DIR must remain inside OPENCLAW_STATE_DIR; an external mount would create split-brain state.",
    });
  } else if (
    configDir &&
    workspaceDir &&
    path.resolve(configDir) !== path.resolve(workspaceDir) &&
    !workspaceIsNestedInConfig
  ) {
    checks.push({
      id: "compose_mounts",
      status: "warn",
      detail:
        "OPENCLAW_CONFIG_DIR and OPENCLAW_WORKSPACE_DIR differ; verify they are two mounts of the same canonical state volume, not two state authorities.",
    });
  } else {
    checks.push({
      id: "compose_mounts",
      status: "pass",
      detail: workspaceIsNestedInConfig
        ? "Workspace mount is nested under the canonical config root."
        : "No split config/workspace mount was detected in the runtime environment.",
    });
  }

  checks.push(
    hasConfiguredSecret(env.OPENCLAW_GATEWAY_TOKEN)
      ? {
          id: "gateway_auth_secret",
          status: "pass",
          detail: "Gateway authentication secret is present without printing its value.",
        }
      : {
          id: "gateway_auth_secret",
          status: "fail",
          detail: "OPENCLAW_GATEWAY_TOKEN is missing.",
        },
  );

  checks.push(checkLocalVisionCloudBoundary(env));

  const localRouteInConfig = await configMentionsLocalVision(configPath);
  if (localRouteInConfig && process.platform !== "darwin") {
    checks.push({
      id: "cloud_config_vision_route",
      status: "fail",
      detail:
        "The copied config still selects mlx-vlm/local on a non-Mac runtime; choose a hosted or GPU vision route before cloud start.",
    });
  } else if (localRouteInConfig) {
    checks.push({
      id: "cloud_config_vision_route",
      status: "warn",
      detail:
        "The config selects mlx-vlm/local; this is valid only for the Mac-local profile, not for the cloud cutover.",
    });
  } else {
    checks.push({
      id: "cloud_config_vision_route",
      status: "pass",
      detail: "No Mac-only mlx-vlm/local route was found in the configured file.",
    });
  }

  const status: "ready" | "needs_review" | "blocked" = checks.some(
    (check) => check.status === "fail",
  )
    ? "blocked"
    : checks.some((check) => check.status === "warn")
      ? "needs_review"
      : "ready";
  return {
    schema: CLOUD_PREFLIGHT_SCHEMA,
    status,
    runtime: "cloud",
    stateAuthority: "one_canonical_state_root",
    checks,
  } as const;
}

async function main(): Promise<number> {
  const result = await buildCloudPreflight();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `status=${result.status}`,
        ...result.checks.map((check) => `${check.status} ${check.id}: ${check.detail}`),
      ].join("\n") + "\n",
    );
  }
  return result.status === "blocked" ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `lcx_cloud_preflight_error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
