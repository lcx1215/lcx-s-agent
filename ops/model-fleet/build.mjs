import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) {
  throw new Error("Pass an absolute, empty output directory");
}
await fs.mkdir(target, { recursive: true });
if ((await fs.readdir(target)).length) {
  throw new Error("Output directory must be empty");
}
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve("tsx/package.json"))("esbuild");
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/plugins/lcx-model-fleet.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(target, "index.js"),
  banner: {
    js: "import { createRequire as lcxCreateRequire } from 'node:module'; const require = lcxCreateRequire(import.meta.url);",
  },
});
await fs.copyFile(
  new URL("./openclaw.plugin.json", import.meta.url),
  path.join(target, "openclaw.plugin.json"),
);
await fs.writeFile(
  path.join(target, "package.json"),
  JSON.stringify(
    {
      name: "@lcx/model-fleet",
      version: "1.0.0",
      type: "module",
      private: true,
      openclaw: { extensions: ["./index.js"] },
    },
    null,
    2,
  ) + "\n",
);
const digest = createHash("sha256")
  .update(await fs.readFile(path.join(target, "index.js")))
  .digest("hex");
await fs.writeFile(
  path.join(target, "build-receipt.json"),
  JSON.stringify(
    { entry: "src/plugins/lcx-model-fleet.ts", sha256: digest, builtAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
console.log(`Built model fleet: ${target}`);
