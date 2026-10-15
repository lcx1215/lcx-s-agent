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
afterEach(() => execFileAsync.mockReset());
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
  it("accepts the exact confined task container", () =>
    expect(() => assertNativeContainer(valid(), expected)).not.toThrow());
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
