import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === "pnpm") {
            fsSync.writeFileSync(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              fsSync.rmSync(path.join(tmp, "dist", "control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([[process.execPath, "openclaw.mjs", "--version"]]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "routes rebuild stdout to stderr for json commands",
    async () => {
      await withTempDir(async (tmp) => {
        const stderrChunks: string[] = [];
        const spawn = (cmd: string, args: string[], options: unknown) => {
          if (cmd === "pnpm") {
            const spawnOptions =
              options && typeof options === "object" && !Array.isArray(options)
                ? (options as { stdio?: unknown })
                : {};
            expect(spawnOptions.stdio).toEqual(["inherit", "pipe", "inherit"]);
            return {
              stdout: {
                on: (event: string, cb: (chunk: Buffer) => void) => {
                  if (event === "data") {
                    queueMicrotask(() => cb(Buffer.from("build chatter\n")));
                  }
                  return undefined;
                },
              },
              on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
                if (event === "exit") {
                  queueMicrotask(() => cb(0, null));
                }
                return undefined;
              },
            };
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["capabilities", "l5-baseline-doctor", "--json"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
          stderr: { write: (chunk: string | Buffer) => stderrChunks.push(String(chunk)) },
        });

        expect(exitCode).toBe(0);
        expect(stderrChunks.join("")).toContain("build chatter");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not treat a parent git repository as a dirty sidecar build",
    async () => {
      await withTempDir(async (tmp) => {
        const sidecar = path.join(tmp, "live-sidecar");
        const srcIndex = path.join(sidecar, "src", "index.ts");
        const distEntry = path.join(sidecar, "dist", "entry.js");
        const buildStamp = path.join(sidecar, "dist", ".buildstamp");

        await fs.mkdir(path.dirname(srcIndex), { recursive: true });
        await fs.mkdir(path.dirname(distEntry), { recursive: true });
        await fs.writeFile(srcIndex, "export {};\n", "utf-8");
        await fs.writeFile(path.join(sidecar, "package.json"), "{}\n", "utf-8");
        await fs.writeFile(path.join(sidecar, "tsconfig.json"), "{}\n", "utf-8");
        await fs.writeFile(distEntry, "#!/usr/bin/env node\n", "utf-8");
        await fs.writeFile(buildStamp, `${JSON.stringify({ head: "parent-head" })}\n`, "utf-8");

        const oldTime = new Date(Date.now() - 30_000);
        const freshTime = new Date();
        await fs.utimes(srcIndex, oldTime, oldTime);
        await fs.utimes(path.join(sidecar, "package.json"), oldTime, oldTime);
        await fs.utimes(path.join(sidecar, "tsconfig.json"), oldTime, oldTime);
        await fs.utimes(distEntry, freshTime, freshTime);
        await fs.utimes(buildStamp, freshTime, freshTime);

        const spawned: string[][] = [];
        const gitCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          spawned.push([cmd, ...args]);
          if (cmd === "pnpm") {
            throw new Error("unexpected rebuild");
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };
        const spawnSync = (cmd: string, args: string[]) => {
          if (cmd === "git") {
            gitCalls.push(args);
            if (args.join(" ") === "rev-parse --show-toplevel") {
              return { status: 0, stdout: `${tmp}\n` };
            }
          }
          return { status: 1, stdout: "" };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: sidecar,
          args: ["channels", "status", "--probe"],
          env: {
            ...process.env,
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          spawnSync,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        expect(spawned).toEqual([
          [process.execPath, "openclaw.mjs", "channels", "status", "--probe"],
        ]);
        expect(gitCalls).toEqual([["rev-parse", "--show-toplevel"]]);
      });
    },
  );
});
