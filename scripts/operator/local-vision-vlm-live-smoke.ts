#!/usr/bin/env node

import {
  DEFAULT_LOCAL_VISION_MODEL,
  resolveLocalVisionRuntimeConfig,
  runLocalVisionVlm,
} from "../../src/agents/local-vision-vlm.ts";
import { resolveMediaToolLocalRoots } from "../../src/agents/tools/media-tool-shared.ts";
import { loadWebMedia } from "../../src/web/media.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/local-vision-vlm-live-smoke.ts --image PATH_OR_URL [options]",
      "",
      "Runs the configured local MLX-VLM model against a real image.",
      "Options:",
      "  --image PATH_OR_URL   required image input",
      "  --prompt TEXT         optional analysis prompt",
      `  --model MODEL         default ${DEFAULT_LOCAL_VISION_MODEL}`,
      "  --max-tokens N        output cap",
      "  --timeout-ms N        process timeout",
      "  --json                emit machine-readable output",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const image = valueAfter(args, "--image");
  if (!image?.trim() || args.includes("--help") || args.includes("-h")) {
    usage();
  }
  const prompt =
    valueAfter(args, "--prompt") ??
    "Analyze this image for chart or dashboard structure. Return concise labeled observations for visible text, axes, series, and directional visual trend (rising, falling, sideways, or uncertain). Keep trend as a direction word, never a price value. Use only pixels; if text is unreadable, say so. Do not repeat phrases and do not give trading instructions.";
  const modelId = valueAfter(args, "--model");
  const maxTokensRaw = valueAfter(args, "--max-tokens");
  const timeoutRaw = valueAfter(args, "--timeout-ms");
  const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  const media = await loadWebMedia(image.trim(), {
    localRoots: resolveMediaToolLocalRoots(process.cwd()),
  });
  if (media.kind !== "image") {
    throw new Error(`unsupported input kind: ${media.kind}`);
  }
  const result = await runLocalVisionVlm({
    images: [
      {
        base64: media.buffer.toString("base64"),
        mimeType: media.contentType ?? "image/png",
      },
    ],
    prompt,
    ...(modelId ? { modelId } : {}),
    ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
  const runtime = resolveLocalVisionRuntimeConfig();
  const details = {
    schema: "lcx_local_vision_vlm_live_smoke_v1",
    status: "ready",
    runtime: "local",
    provider: "mlx-vlm",
    model: result.model,
    pythonPath: result.pythonPath,
    image,
    text: result.text,
    envEnabled: runtime.enabled,
    routeRef: "mlx-vlm/local",
    boundary:
      "Visual interpretation is research context only; numeric market data and any trading action remain separate authorities.",
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(details, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `status=${details.status}`,
        `runtime=${details.runtime}`,
        `provider=${details.provider}`,
        `model=${details.model}`,
        `python=${details.pythonPath}`,
        `text=${details.text.replace(/\s+/gu, " ")}`,
        details.boundary,
      ].join("\n") + "\n",
    );
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `local_vision_vlm_error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
