import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { DEFAULT_SANDBOX_IMAGE } from "../sandbox/constants.js";
import { buildSandboxCreateArgs } from "../sandbox/docker.js";
import { createSandboxFsBridge } from "../sandbox/fs-bridge.js";
import type { SandboxContext, SandboxDockerConfig } from "../sandbox/types.js";

const exec = promisify(execFile);
export type NativeContainer = {
  id: string;
  name: string;
  taskId: string;
  workspaceDir: string;
  sandbox: SandboxContext;
};
export type NativeDocker = {
  create(params: {
    taskId: string;
    workspaceDir: string;
    image?: string;
    signal: AbortSignal;
    allocated: (name: string) => Promise<void>;
  }): Promise<NativeContainer>;
  destroy(identity: { id?: string; name: string; taskId: string }): Promise<boolean>;
  verify(
    container: NativeContainer,
    argv: readonly string[],
    signal: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
};
async function docker(args: string[], signal?: AbortSignal) {
  return exec("docker", args, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
}
type Inspect = {
  Id: string;
  Name: string;
  State: { Running: boolean };
  Config: { User?: string; Labels?: Record<string, string>; Env?: string[] };
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapDrop?: string[];
    CapAdd?: string[];
    SecurityOpt?: string[];
    PidMode?: string;
    IpcMode?: string;
    UTSMode?: string;
    UsernsMode?: string;
    Devices?: unknown[];
    DeviceRequests?: unknown[];
    Binds?: string[];
    VolumesFrom?: string[];
    PortBindings?: Record<string, unknown>;
  };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
};
async function inspect(identity: string): Promise<Inspect> {
  const result = await docker(["inspect", identity]);
  const items: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error("invalid Docker inspect result");
  }
  return items[0] as Inspect;
}
export function assertNativeContainer(
  inspected: Inspect,
  expected: { taskId: string; workspaceDir: string; name: string; user: string },
): void {
  const h = inspected.HostConfig;
  if (
    !/^[a-f0-9]{64}$/.test(inspected.Id) ||
    inspected.Name !== `/${expected.name}` ||
    inspected.Config.Labels?.["lcx.native.task"] !== expected.taskId ||
    inspected.Config.User !== expected.user ||
    !inspected.State.Running
  ) {
    throw new Error("native Docker identity/running state mismatch");
  }
  if (
    h.NetworkMode !== "none" ||
    !h.ReadonlyRootfs ||
    h.Privileged ||
    !h.CapDrop?.some((c) => c.toUpperCase() === "ALL") ||
    h.CapAdd?.length ||
    !h.SecurityOpt?.some((s) => s === "no-new-privileges" || s === "no-new-privileges=true") ||
    h.SecurityOpt?.some((s) => !["no-new-privileges", "no-new-privileges=true"].includes(s)) ||
    h.PidMode ||
    h.UTSMode ||
    h.UsernsMode ||
    ![undefined, "", "private"].includes(h.IpcMode) ||
    h.Devices?.length ||
    h.DeviceRequests?.length ||
    h.VolumesFrom?.length ||
    Object.keys(h.PortBindings ?? {}).length
  ) {
    throw new Error("native Docker isolation configuration mismatch");
  }
  if (inspected.Mounts.length !== 1) {
    throw new Error("native Docker requires exactly one task mount");
  }
  const mount = inspected.Mounts[0];
  if (
    mount.Type !== "bind" ||
    mount.Source !== expected.workspaceDir ||
    mount.Destination !== "/workspace" ||
    !mount.RW
  ) {
    throw new Error("native Docker task mount mismatch");
  }
  const env = inspected.Config.Env ?? [];
  if (
    env.some(
      (value) =>
        ![/^PATH=/, /^LANG=C\.UTF-8$/, /^HOME=\/tmp$/, /^DEBIAN_FRONTEND=noninteractive$/].some(
          (pattern) => pattern.test(value),
        ),
    )
  ) {
    throw new Error("native Docker image contains unapproved environment");
  }
}
export const nativeDocker: NativeDocker = {
  async create({ taskId, workspaceDir, image, signal, allocated }) {
    await docker(["version", "--format", "{{.Server.Version}}"], signal);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || gid === undefined) {
      throw new Error("native Docker requires a non-root host uid and gid");
    }
    const user = `${uid}:${gid}`;
    workspaceDir = await fs.realpath(workspaceDir);
    const name = `lcx-native-${randomUUID()}`;
    await allocated(name);
    const config: SandboxDockerConfig = {
      image: image ?? DEFAULT_SANDBOX_IMAGE,
      containerPrefix: "lcx-native-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      user,
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8", HOME: "/tmp" },
      pidsLimit: 128,
      memory: "512m",
      cpus: 1,
    };
    const args = buildSandboxCreateArgs({
      name,
      cfg: config,
      scopeKey: taskId,
      labels: { "lcx.native.task": taskId },
      includeBinds: false,
    });
    args.push(
      "--mount",
      `type=bind,source=${workspaceDir},target=/workspace`,
      "--workdir",
      "/workspace",
      config.image,
      "sleep",
      "infinity",
    );
    const created = await docker(args, signal);
    const id = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) {
      throw new Error("Docker did not return a container ID");
    }
    await docker(["start", id], signal);
    const actual = await inspect(id);
    assertNativeContainer(actual, { taskId, workspaceDir, name, user });
    const sandbox: SandboxContext = {
      enabled: true,
      sessionKey: taskId,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "rw",
      containerName: id,
      containerWorkdir: "/workspace",
      docker: config,
      tools: { allow: ["read", "write", "edit", "apply_patch", "exec"], deny: ["process"] },
      browserAllowHostControl: false,
    };
    sandbox.fsBridge = createSandboxFsBridge({ sandbox });
    return { id, name, taskId, workspaceDir, sandbox };
  },
  async destroy(identity) {
    try {
      const actual = await inspect(identity.id ?? identity.name);
      if (
        actual.Config.Labels?.["lcx.native.task"] !== identity.taskId ||
        actual.Name !== `/${identity.name}` ||
        (identity.id && actual.Id !== identity.id)
      ) {
        return false;
      }
      await docker(["rm", "--force", actual.Id]);
      try {
        await inspect(actual.Id);
        return false;
      } catch (error) {
        return (
          Boolean(identity.id) &&
          /No such (object|container)/i.test(String((error as { stderr?: string }).stderr ?? error))
        );
      }
    } catch (error) {
      return (
        Boolean(identity.id) &&
        /No such (object|container)/i.test(String((error as { stderr?: string }).stderr ?? error))
      );
    }
  },
  async verify(container, argv, signal) {
    if (!argv.length || argv.some((value) => typeof value !== "string" || value.includes("\0"))) {
      throw new Error("verification requires trusted argv");
    }
    try {
      const result = await docker(
        ["exec", "--workdir", "/workspace", container.id, ...argv],
        signal,
      );
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failure.code !== "number") {
        throw error;
      }
      return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  },
};
