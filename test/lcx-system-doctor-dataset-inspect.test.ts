import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-dataset-"));
  roots.push(root);
  const out = path.join(root, "dataset");
  const source = fs.readFileSync(path.join(repo, "scripts/operator/lcx-system-doctor.ts"), "utf8");
  const invocation = source.match(
    /args: (\[\s*"--import",\s*"tsx",\s*"scripts\/operator\/local-brain-distill-dataset\.ts"[^\]]*\])/u,
  );
  expect(invocation).not.toBeNull();
  const args = JSON.parse(invocation![1].replace(/,\s*\]/u, "]")) as string[];
  expect(args).toContain("--inspect");
  const run = () =>
    spawnSync(
      process.execPath,
      [...args, "--out", out, "--workspace", path.join(root, "workspace")],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: root, LCX_USER_HOME: root },
      },
    );
  return { root, out, run };
}

describe("doctor dataset inspection", () => {
  it("reports a missing dataset without creating directories or seed data", () => {
    const { root, out, run } = fixture();
    const result = run();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      mode: "inspect",
      reason: "dataset_missing_or_unreadable",
    });
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("reads the existing snapshot without rewriting any dataset file", () => {
    const { out, run } = fixture();
    fs.mkdirSync(out);
    const contents: Record<string, string> = {
      "manifest.json": JSON.stringify({
        ok: true,
        counts: { train: 7 },
        sourceKinds: { fixture: 7 },
      }),
      "train.jsonl": "training sentinel\n",
      "valid.jsonl": "validation sentinel\n",
      "test.jsonl": "test sentinel\n",
    };
    for (const [name, text] of Object.entries(contents)) {
      fs.writeFileSync(path.join(out, name), text);
    }
    const mtimes = Object.keys(contents).map((name) => fs.statSync(path.join(out, name)).mtimeMs);
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: "inspect",
      storedSnapshot: true,
      counts: { train: 7 },
    });
    expect(fs.readdirSync(out).toSorted()).toEqual(Object.keys(contents).toSorted());
    for (const [name, text] of Object.entries(contents)) {
      expect(fs.readFileSync(path.join(out, name), "utf8")).toBe(text);
    }
    expect(Object.keys(contents).map((name) => fs.statSync(path.join(out, name)).mtimeMs)).toEqual(
      mtimes,
    );
    fs.unlinkSync(path.join(out, "valid.jsonl"));
    expect(run().status).toBe(1);
    expect(fs.existsSync(path.join(out, "valid.jsonl"))).toBe(false);
  });
});
