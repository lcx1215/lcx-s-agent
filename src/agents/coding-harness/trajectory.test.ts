import { describe, expect, it } from "vitest";
import {
  AppendOnlyCodingTrajectory,
  CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION,
} from "./trajectory.js";

describe("AppendOnlyCodingTrajectory", () => {
  it("replays a verified run and redacts sensitive fields", () => {
    const trajectory = new AppendOnlyCodingTrajectory("run-1");
    trajectory.append(
      "run/requested",
      {
        task: "implement a feature",
        apiKey: "do-not-persist",
      },
      "2026-09-03T00:00:00.000Z",
    );
    trajectory.append("run/accepted", { childRunId: "child-1" }, "2026-09-03T00:00:01.000Z");
    trajectory.append(
      "workspace/observed",
      {
        changedPaths: ["src/example.ts"],
      },
      "2026-09-03T00:00:02.000Z",
    );
    trajectory.append("verification/observed", { status: "passed" }, "2026-09-03T00:00:03.000Z");
    trajectory.append("run/completed", { verified: true }, "2026-09-03T00:00:04.000Z");

    expect(trajectory.replay()).toEqual({
      runId: "run-1",
      status: "completed",
      executorAccepted: true,
      historyObserved: false,
      changedPaths: ["src/example.ts"],
      verification: "passed",
      eventCount: 5,
    });
    expect(trajectory.toJSONL()).not.toContain("do-not-persist");
    expect(trajectory.toJSONL()).toContain("[redacted]");
  });

  it("supports resume, fork, and JSONL replay without changing the source log", () => {
    const source = new AppendOnlyCodingTrajectory("run-source");
    source.append("run/requested", { task: "one" }, "2026-09-03T00:00:00.000Z");
    source.append("run/accepted", {}, "2026-09-03T00:00:01.000Z");

    const resumed = source.resume("2026-09-03T00:00:02.000Z");
    const forked = source.fork("run-fork", 2, "2026-09-03T00:00:03.000Z");
    const restored = AppendOnlyCodingTrajectory.fromJSONL("run-source", source.toJSONL());

    expect(source.events).toHaveLength(2);
    expect(resumed.events.at(-1)?.kind).toBe("run/resumed");
    expect(forked.runId).toBe("run-fork");
    expect(forked.events.at(-1)?.kind).toBe("run/forked");
    expect(restored.events).toEqual(source.events);
    expect(restored.events[0]?.schemaVersion).toBe(CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION);
  });

  it("redacts secrets embedded in arbitrary trajectory strings", () => {
    const trajectory = new AppendOnlyCodingTrajectory("run-secret-text");
    trajectory.append("run/failed", {
      error:
        'Authorization: Bearer bearer-secret, signed=https://example.test/callback?token=url-secret&sig=signature-secret --api-key cli-secret; nested={"authorization":"Bearer nested-secret"}',
    });

    const jsonl = trajectory.toJSONL();
    expect(jsonl).not.toContain("bearer-secret");
    expect(jsonl).not.toContain("url-secret");
    expect(jsonl).not.toContain("signature-secret");
    expect(jsonl).not.toContain("cli-secret");
    expect(jsonl).not.toContain("nested-secret");
    expect(jsonl).toContain("[redacted]");
  });

  it("fails closed on a sequence gap", () => {
    expect(
      () =>
        new AppendOnlyCodingTrajectory("run-gap", [
          {
            schemaVersion: CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION,
            runId: "run-gap",
            sequence: 2,
            kind: "run/requested",
            at: "2026-09-03T00:00:00.000Z",
            data: {},
          },
        ]),
    ).toThrow(/sequence gap/i);
  });

  it("fails closed on an unknown event kind", () => {
    expect(
      () =>
        new AppendOnlyCodingTrajectory("run-unknown", [
          {
            schemaVersion: CODING_HARNESS_TRAJECTORY_SCHEMA_VERSION,
            runId: "run-unknown",
            sequence: 1,
            kind: "run/unknown" as never,
            at: "2026-09-03T00:00:00.000Z",
            data: {},
          },
        ]),
    ).toThrow(/malformed|unknown|event/i);
  });
});
