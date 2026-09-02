const prompt = process.argv.at(-1) ?? "";

if (!prompt) {
  throw new Error(
    "Usage: node --import tsx test/fixtures/local-brain-open-eval-provider-timeout.ts TEXT",
  );
}

setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      task_family: "delayed_response",
      primary_modules: [],
      supporting_modules: [],
      required_tools: [],
      missing_data: [],
      risk_boundaries: ["research_only"],
      next_step: "retry_with_real_provider",
      rejected_context: ["old_external_conversation_history"],
    }),
  );
}, 1_000_000);
