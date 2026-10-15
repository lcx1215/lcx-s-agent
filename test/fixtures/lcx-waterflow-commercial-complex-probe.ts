import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readProviderCouncilEvidence } from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import { runExternalLearningCouncil } from "../../src/agents/provider-learning-council.js";
import { buildLearningCouncilArtifactJsonRelativePath } from "../../src/hooks/bundled/lobster-brain-registry.js";

export const COMMERCIAL_COMPLEX_ASK =
  "FOMC 和 CPI 前，Kimi、MiniMax、DeepSeek 分别复核 QQQ 和 TLT 的组合风险。MiniMax 多审一轮，只给研究框架、证据缺口和失效条件；意见分歧按证据排序，不预测、不下单，LCX 本地 gate 最后决定。";

/** Explicit original council entry, not evidence that the default reply dispatches a council. */
export async function produceOriginalComplexCouncil(directory: string) {
  const messageId = `external-${path.basename(directory)}`;
  const input = {
    cfg: {
      agents: {
        defaults: {
          workspace: directory,
          models: { "custom-api-deepseek-com/deepseek-v4-flash": {} },
        },
      },
    },
    userMessage: COMMERCIAL_COMPLEX_ASK,
    routeAgentId: "main",
    sessionKey: "agent:main:main",
    messageId,
    workspaceDir: directory,
    captureProcessEvidence: true,
  };
  const finalReply = await runExternalLearningCouncil(input);
  const artifactPath = path.join(
    directory,
    buildLearningCouncilArtifactJsonRelativePath(messageId),
  );
  const raw = await fs.readFile(artifactPath, "utf8");
  const evidence = await readProviderCouncilEvidence(artifactPath, messageId);
  return {
    input,
    finalReply,
    artifactReadback: {
      path: artifactPath,
      raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: Buffer.byteLength(raw),
    },
    artifact: JSON.parse(raw) as Record<string, unknown>,
    evidence,
  };
}
