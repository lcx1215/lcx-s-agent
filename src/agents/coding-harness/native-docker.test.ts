import { describe, expect, it } from "vitest";
import { assertNativeContainer } from "./native-docker.js";
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
