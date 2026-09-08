#!/usr/bin/env node
import { createResearchDataToolHost } from "../../src/agents/research-data-tool-host.js";
import { resolveWorkspaceRoot } from "../../src/agents/workspace-dir.js";

async function main() {
  const args = process.argv.slice(2);
  const workspaceIndex = args.indexOf("--workspace");
  if (
    workspaceIndex >= 0 &&
    (!args[workspaceIndex + 1] || args[workspaceIndex + 1].startsWith("--"))
  ) {
    throw new Error("--workspace requires a directory");
  }
  const workspaceDir = resolveWorkspaceRoot(
    workspaceIndex < 0 ? undefined : args[workspaceIndex + 1],
  );
  const host = createResearchDataToolHost({
    workspaceDir,
    modelHasVision: args.includes("--vision"),
  });
  if (args.includes("--list")) {
    console.log(JSON.stringify(host.list()));
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) {
      throw new Error("tool input too large");
    }
  }
  const request: unknown = JSON.parse(input);
  if (
    !request ||
    typeof request !== "object" ||
    !("tool" in request) ||
    typeof request.tool !== "string" ||
    !("arguments" in request)
  ) {
    throw new Error("expected tool and arguments JSON object on stdin");
  }
  console.log(
    JSON.stringify(await host.execute({ tool: request.tool, arguments: request.arguments })),
  );
}
main().catch(() => {
  console.error("research data tool failed; check tool name, schema and local runtime");
  process.exitCode = 1;
});
