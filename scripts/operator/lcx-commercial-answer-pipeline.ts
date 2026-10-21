import { pathToFileURL } from "node:url";
import {
  buildPipelineResult,
  parseArgs,
  readProviderCouncilEvidence,
  readFinanceCandidateContext,
  runScenarioSuite,
} from "../../src/agents/commercial-answer-pipeline.js";

// Preserve the original operator entry and exports; runtime code shares the same owner in src.
export * from "../../src/agents/commercial-answer-pipeline.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const result =
    options.ask && options.candidateAnswer
      ? buildPipelineResult(options.ask, options.candidateAnswer, {
          financeDecisionMode: options.financeDecisionMode,
          ...(options.candidateContextPath
            ? { candidateContext: await readFinanceCandidateContext(options.candidateContextPath) }
            : {}),
          ...(options.providerEvidencePath && options.providerMessageId
            ? {
                providerEvidence: await readProviderCouncilEvidence(
                  options.providerEvidencePath,
                  options.providerMessageId,
                  options.providerEvidenceSha256,
                ),
              }
            : {}),
        })
      : runScenarioSuite();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
