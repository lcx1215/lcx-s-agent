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

  let lastParsed: Record<string, unknown> | undefined;
  let searchFrom = 0;
  while (searchFrom < trimmed.length) {
    const start = trimmed.indexOf("{", searchFrom);
    if (start < 0) {
      break;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let advanced = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth !== 0) {
          continue;
        }
        const candidate = trimmed.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            lastParsed = parsed as Record<string, unknown>;
            searchFrom = index + 1;
          } else {
            searchFrom = start + 1;
          }
          advanced = true;
        } catch {
          // Keep scanning; this brace pair may belong to non-JSON chatter.
          searchFrom = start + 1;
          advanced = true;
        }
        break;
      }
    }
    if (!advanced) {
      searchFrom = start + 1;
    }
  }
  if (lastParsed) {
    return lastParsed;
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
