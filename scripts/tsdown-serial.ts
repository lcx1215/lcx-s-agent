import { spawn } from "node:child_process";
import config from "../tsdown.config.ts";

const configCount = Array.isArray(config) ? config.length : 1;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeOptions = process.env.NODE_OPTIONS?.trim() || "--max-old-space-size=6144";

for (let index = 0; index < configCount; index += 1) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "tsdown"], {
      env: {
        ...process.env,
        LCX_TSDOWN_CONFIG_INDEX: String(index),
        NODE_OPTIONS: nodeOptions,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tsdown config ${index} failed (${signal ?? `exit ${code}`})`));
    });
  });
}
