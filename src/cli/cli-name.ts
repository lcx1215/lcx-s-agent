import path from "node:path";
import {
  CANONICAL_CLI_NAME,
  CLI_NAME_ALIASES,
  KNOWN_CLI_NAMES,
} from "../infra/canonical-identity.js";

export const DEFAULT_CLI_NAME = CANONICAL_CLI_NAME;

const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(lcx|openclaw)\b/;
const CLI_SCRIPT_SUFFIX_RE = /\.(?:m?js)$/i;

export { CLI_NAME_ALIASES };

export function resolveCliName(argv: string[] = process.argv): string {
  const argv1 = argv[1];
  if (!argv1) {
    return DEFAULT_CLI_NAME;
  }
  const base = path.basename(argv1).trim().replace(CLI_SCRIPT_SUFFIX_RE, "");
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  return DEFAULT_CLI_NAME;
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
