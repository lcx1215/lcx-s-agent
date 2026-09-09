import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const script = fileURLToPath(
  new URL("../../scripts/operator/lcx-research-data-tool.ts", import.meta.url),
);
const loader = import.meta.resolve("tsx");
async function setup(config: object = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-cli-"));
  roots.push(root);
  const state = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  await fs.mkdir(state);
  await fs.writeFile(configPath, JSON.stringify(config));
  const cwdA = path.join(root, "checkout-a");
  const cwdB = path.join(root, "checkout-b");
  await fs.mkdir(cwdA);
  await fs.mkdir(cwdB);
  return { root, state, configPath, cwdA, cwdB };
}
function run(cwd: string, state: string, configPath: string, args: string[] = []) {
  return JSON.parse(
    execFileSync(process.execPath, ["--import", loader, script, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_PROFILE: "default",
      },
      input: JSON.stringify({
        tool: "research_data_autopilot",
        arguments: { intent: "source_health", target: "all", liveFetch: false, writeReceipt: true },
      }),
    }),
  );
}
it("writes CLI receipts to the same active workspace from different checkouts", async () => {
  const ctx = await setup();
  const first = run(ctx.cwdA, ctx.state, ctx.configPath);
  const second = run(ctx.cwdB, ctx.state, ctx.configPath);
  for (const result of [first, second]) {
    await expect(
      fs.stat(path.join(ctx.state, "workspace", result.details.receiptPath)),
    ).resolves.toBeDefined();
  }
  await expect(fs.access(path.join(ctx.cwdA, "memory"))).rejects.toThrow();
  await expect(fs.access(path.join(ctx.cwdB, "memory"))).rejects.toThrow();
}, 40_000);
it("honors configured workspace and an explicit CLI override", async () => {
  const ctx = await setup();
  const configured = path.join(ctx.root, "configured");
  const explicit = path.join(ctx.root, "explicit");
  await fs.writeFile(
    ctx.configPath,
    JSON.stringify({ agents: { defaults: { workspace: configured } } }),
  );
  const first = run(ctx.cwdA, ctx.state, ctx.configPath);
  const second = run(ctx.cwdA, ctx.state, ctx.configPath, ["--workspace", explicit]);
  await expect(fs.stat(path.join(configured, first.details.receiptPath))).resolves.toBeDefined();
  await expect(fs.stat(path.join(explicit, second.details.receiptPath))).resolves.toBeDefined();
}, 40_000);
