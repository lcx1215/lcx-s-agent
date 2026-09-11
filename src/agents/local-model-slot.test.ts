import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildLocalMlxCommand } from "./local-model-slot.js";

describe("local model slot", () => {
  it("passes prompts as argv and shares a nonblocking OS lock across engines", () => {
    const text = buildLocalMlxCommand("mlx_lm", ["generate", "--prompt", "untrusted ' text"]);
    const vision = buildLocalMlxCommand("mlx_vlm", ["generate"]);
    expect(text[1]).toBe(vision[1]);
    expect(text[1]).toContain("LOCK_NB");
    expect(text[1]).not.toContain("untrusted");
    expect(text.at(-1)).toBe("untrusted ' text");
  });
  it("fails busy before importing a model runtime", async () => {
    const args = buildLocalMlxCommand("mlx_lm", []);
    // Hold the same lock in the parent interpreter; the child must fail before MLX import.
    const code = `import fcntl, os, subprocess, sys, tempfile\nf=open(os.path.join(tempfile.gettempdir(),'lcx-local-model-'+str(os.getuid())+'.lock'),'a')\nfcntl.flock(f,fcntl.LOCK_EX)\np=subprocess.run([sys.executable]+sys.argv[1:],capture_output=True,text=True)\nprint(p.returncode, p.stderr.strip())`;
    const result = await promisify(execFile)("python3", ["-c", code, ...args]);
    expect(result.stdout).toContain("1 local_model_busy");
  });
});
