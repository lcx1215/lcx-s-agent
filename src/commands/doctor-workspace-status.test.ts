import { describe, expect, it } from "vitest";
import type { SkillStatusReport } from "../agents/skills-status.js";
import { formatDoctorSkillsStatus } from "./doctor-workspace-status.js";

function makeReport(
  skills: Array<Partial<SkillStatusReport["skills"][number]>>,
): SkillStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: skills.map((skill, index) => ({
      name: `skill-${index}`,
      description: "",
      source: "test",
      bundled: false,
      filePath: `/tmp/skills/skill-${index}/SKILL.md`,
      baseDir: `/tmp/skills/skill-${index}`,
      skillKey: `skill-${index}`,
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: false,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
      ...skill,
    })),
  };
}

describe("formatDoctorSkillsStatus", () => {
  it("labels missing skill requirements as optional integrations", () => {
    const report = makeReport([
      { eligible: true },
      { eligible: false },
      { eligible: false, blockedByAllowlist: true },
    ]);

    expect(formatDoctorSkillsStatus(report)).toBe(
      ["Ready: 1", "Optional integrations missing requirements: 1", "Blocked by allowlist: 1"].join(
        "\n",
      ),
    );
  });
});
