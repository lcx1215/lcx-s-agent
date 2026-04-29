export function parseJsonObjectFromOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("command produced no JSON output");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to tolerate package-manager banners or warning chatter.
  }

  for (let end = trimmed.lastIndexOf("}"); end !== -1; end = trimmed.lastIndexOf("}", end - 1)) {
    for (
      let start = trimmed.lastIndexOf("{", end);
      start !== -1;
      start = trimmed.lastIndexOf("{", start - 1)
    ) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Keep scanning for the outer object when this brace pair is nested.
      }
    }
  }

  throw new Error(`command output did not contain a JSON object; tail=${trimmed.slice(-300)}`);
}
