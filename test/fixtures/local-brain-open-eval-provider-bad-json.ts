const prompt = process.argv.at(-1) ?? "";

if (!prompt) {
  throw new Error(
    "Usage: node --import tsx test/fixtures/local-brain-open-eval-provider-bad-json.ts TEXT",
  );
}

process.stdout.write("not-json-output\\n");
