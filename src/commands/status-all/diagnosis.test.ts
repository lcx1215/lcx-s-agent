import { describe, expect, it } from "vitest";
import { inspectMacBuildToolchain } from "./diagnosis.js";

describe("inspectMacBuildToolchain", () => {
  it("reports non-mac platforms as not applicable", () => {
    expect(inspectMacBuildToolchain({ platform: "linux" })).toEqual({
      status: "not_applicable",
      reason: null,
      developerDir: null,
      fix: null,
    });
  });

  it("blocks mac app rebuilds when xcode-select points at CommandLineTools", () => {
    const status = inspectMacBuildToolchain({
      platform: "darwin",
      runCommand: (command) => {
        if (command === "swift") {
          return { ok: true, stdout: "Apple Swift version 6.3" };
        }
        if (command === "xcode-select") {
          return { ok: true, stdout: "/Library/Developer/CommandLineTools" };
        }
        return { ok: false, stdout: "" };
      },
    });

    expect(status).toMatchObject({
      status: "blocked",
      developerDir: "/Library/Developer/CommandLineTools",
      reason: "full Xcode is required for Swift package macro plugins used by mac app dependencies",
    });
    expect(status.fix).toContain("sudo xcode-select -s /Applications/Xcode.app/Contents/Developer");
  });

  it("reports ready when full Xcode and xcodebuild are usable", () => {
    expect(
      inspectMacBuildToolchain({
        platform: "darwin",
        runCommand: (command) => {
          if (command === "swift") {
            return { ok: true, stdout: "Apple Swift version 6.3" };
          }
          if (command === "xcode-select") {
            return { ok: true, stdout: "/Applications/Xcode.app/Contents/Developer" };
          }
          if (command === "xcodebuild") {
            return { ok: true, stdout: "Xcode 26.0" };
          }
          return { ok: false, stdout: "" };
        },
      }),
    ).toEqual({
      status: "ready",
      reason: null,
      developerDir: "/Applications/Xcode.app/Contents/Developer",
      fix: null,
    });
  });
});
