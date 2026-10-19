import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...original,
    execFile: Object.defineProperty(vi.fn(), promisify.custom, { value: execFileAsync }),
  };
});
afterEach(() => {
  execFileAsync.mockReset();
  vi.restoreAllMocks();
});
import { assertNativeContainer, nativeDocker } from "./native-docker.js";
function valid() {
  return {
    Id: "a".repeat(64),
    Name: "/fixture",
    State: { Running: true },
    Config: {
      User: "501:20",
      Labels: { "lcx.native.task": "task" },
      Env: ["PATH=/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/tmp"],
    },
    HostConfig: {
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m,mode=1777" } as Record<string, string>,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges"],
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      Devices: [],
      DeviceRequests: [],
      VolumesFrom: [],
      PortBindings: {},
    },
    Mounts: [{ Type: "bind", Source: "/task", Destination: "/workspace", RW: true }],
  };
}
const expected = { taskId: "task", workspaceDir: "/task", name: "fixture", user: "501:20" };
describe("actual native Docker isolation validation", () => {
  it.each<Record<string, string>>([
    {},
    { "/tmp": "rw,nosuid,nodev,mode=1777" },
    { "/tmp": "rw,nosuid,nodev,size=64m,mode=0777" },
    { "/tmp": "rw,suid,nodev,size=64m,mode=1777" },
    { "/tmp": "rw,nosuid,nodev,size=64m,mode=1777", "/other": "rw" },
  ])("rejects missing, unbounded or unexpected temporary mounts: %j", (tmpfs) => {
    const value = valid();
    value.HostConfig.Tmpfs = tmpfs;
    expect(() => assertNativeContainer(value, expected)).toThrow("temporary mount");
  });
  it("accepts the exact confined task container", () =>
    expect(() => assertNativeContainer(valid(), expected)).not.toThrow());
  it("validates the temporary mount when exposed alongside the task bind", () => {
    const value = valid();
    value.Mounts.push({ Type: "tmpfs", Source: "", Destination: "/tmp", RW: true });
    expect(() => assertNativeContainer(value, expected)).not.toThrow();
    value.Mounts[1].Type = "bind";
    value.Mounts[1].Source = "/host/tmp";
    expect(() => assertNativeContainer(value, expected)).toThrow();
  });
  it.each([
    ["network", { NetworkMode: "host" }],
    ["privileged", { Privileged: true }],
    ["root writable", { ReadonlyRootfs: false }],
    ["host pid", { PidMode: "host" }],
    ["host ipc", { IpcMode: "host" }],
    ["host uts", { UTSMode: "host" }],
    ["host userns", { UsernsMode: "host" }],
    ["cap add", { CapAdd: ["SYS_ADMIN"] }],
    ["cap missing", { CapDrop: [] }],
    ["privilege escalation", { SecurityOpt: [] }],
    ["devices", { Devices: [{}] }],
    ["gpu", { DeviceRequests: [{}] }],
    ["volumes", { VolumesFrom: ["other"] }],
    ["ports", { PortBindings: { "80": [] } }],
  ])("rejects %s", (_name, changed) => {
    const value = valid();
    Object.assign(value.HostConfig, changed);
    expect(() => assertNativeContainer(value, expected)).toThrow();
  });
  it("rejects host credential env, extra mounts, wrong source, read-only mount and wrong identity", () => {
    let value = valid();
    value.Config.Env.push("SECRET=fixture");
    expect(() => assertNativeContainer(value, expected)).toThrow();
    value = valid();
    value.Mounts.push({ ...value.Mounts[0], Source: "/secret" });
    expect(() => assertNativeContainer(value, expected)).toThrow();
    value = valid();
    value.Mounts[0].Source = "/other";
    expect(() => assertNativeContainer(value, expected)).toThrow();
    value = valid();
    value.Mounts[0].RW = false;
    expect(() => assertNativeContainer(value, expected)).toThrow();
    value = valid();
    value.Id = "not-an-id";
    expect(() => assertNativeContainer(value, expected)).toThrow();
  });
});

it.skipIf(!process.getuid || !process.getgid)(
  "creates a bounded writable temporary filesystem with the read-only root",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-tmpfs-"));
    vi.spyOn(process, "getuid").mockReturnValue(501);
    vi.spyOn(process, "getgid").mockReturnValue(20);
    let name = "";
    execFileAsync.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "create") {
        name = args[args.indexOf("--name") + 1];
        expect(args).toContain("--read-only");
        expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,nosuid,nodev,size=64m,mode=1777");
        return { stdout: "a".repeat(64), stderr: "" };
      }
      if (args[0] === "inspect") {
        const value = valid();
        value.Name = `/${name}`;
        value.Mounts[0].Source = await fs.realpath(directory);
        return { stdout: JSON.stringify([value]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    try {
      const result = await nativeDocker.create({
        taskId: "task",
        workspaceDir: directory,
        signal: new AbortController().signal,
        allocated: async () => {},
      });
      expect(result.sandbox.docker.tmpfs).toEqual(["/tmp:rw,nosuid,nodev,size=64m,mode=1777"]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it("confirms cleanup by resolved ID after recovering a name-only allocation", async () => {
  execFileAsync
    .mockResolvedValueOnce({ stdout: JSON.stringify([valid()]), stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockRejectedValueOnce(Object.assign(new Error("missing"), { stderr: "No such object" }));
  expect(await nativeDocker.destroy({ name: "fixture", taskId: "task" })).toBe(true);
  expect(execFileAsync).toHaveBeenNthCalledWith(
    2,
    "docker",
    ["rm", "--force", "a".repeat(64)],
    expect.any(Object),
  );
  expect(execFileAsync).toHaveBeenNthCalledWith(
    3,
    "docker",
    ["inspect", "a".repeat(64)],
    expect.any(Object),
  );
});
it("keeps an absent never-resolved name-only allocation unconfirmed", async () => {
  execFileAsync.mockRejectedValueOnce(
    Object.assign(new Error("missing"), { stderr: "No such object" }),
  );
  expect(await nativeDocker.destroy({ name: "fixture", taskId: "task" })).toBe(false);
});
