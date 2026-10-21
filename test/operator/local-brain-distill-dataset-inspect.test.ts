import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let directory: string;
const files = ["manifest.json", "train.jsonl", "valid.jsonl", "test.jsonl"];
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-inspect-"));
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({ ok: true, counts: { train: 1, valid: 1, test: 1 } }),
  );
  for (const split of files.slice(1)) {
    await fs.writeFile(
      path.join(directory, split),
      JSON.stringify({ prompt: "question", completion: "answer" }) + "\n",
    );
  }
});
afterEach(async () => {
  await fs.chmod(path.join(directory, "train.jsonl"), 0o600).catch(() => undefined);
  await fs.rm(directory, { recursive: true, force: true });
});
async function inspect() {
  const before = await Promise.all(
    files.map(async (file) =>
      createHash("sha256")
        .update(await fs.readFile(path.join(directory, file)))
        .digest("hex"),
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/local-brain-distill-dataset.ts",
      "--inspect",
      "--out",
      directory,
      "--json",
    ],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 20000 },
  );
  const after = await Promise.all(
    files.map(async (file) =>
      createHash("sha256")
        .update(await fs.readFile(path.join(directory, file)))
        .digest("hex"),
    ),
  );
  expect(after).toEqual(before);
  return { status: result.status, body: JSON.parse(result.stdout) };
}
it("validates actual rows and preserves every input byte", async () => {
  expect(await inspect()).toMatchObject({
    status: 0,
    body: { ok: true, mode: "inspect", counts: { train: 1, valid: 1, test: 1 } },
  });
});
it.each([
  ["empty", "", "dataset_split_count_mismatch"],
  ["truncated", '{"prompt":', "dataset_split_invalid_json"],
  ["non_json", "not json\n", "dataset_split_invalid_json"],
  ["invalid_row", "{}\n", "dataset_split_invalid_row"],
  [
    "count_mismatch",
    JSON.stringify({ prompt: "q", completion: "a" }) +
      "\n" +
      JSON.stringify({ prompt: "q2", completion: "a2" }) +
      "\n",
    "dataset_split_count_mismatch",
  ],
])("refuses %s despite an old successful manifest", async (_fault, body, reason) => {
  await fs.writeFile(path.join(directory, "train.jsonl"), body);
  expect(await inspect()).toMatchObject({ status: 1, body: { ok: false, reason } });
});
