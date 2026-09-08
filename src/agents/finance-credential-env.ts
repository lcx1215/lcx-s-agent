import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveStateDir } from "../config/paths.js";

export const FINANCE_CREDENTIAL_KEYS = [
  "ALPHA_VANTAGE_API_KEY",
  "COINGECKO_API_KEY",
  "COINCAP_API_KEY",
  "MASSIVE_API_KEY",
  "ALPACA_API_KEY_ID",
  "ALPACA_API_SECRET_KEY",
  "ALPACA_DATA_FEED",
  "FINNHUB_API_KEY",
  "TWELVE_DATA_API_KEY",
  "FRED_API_KEY",
  "FMP_API_KEY",
  "LCX_FINANCE_HTTP_PROXY",
] as const;

/** Read the existing dedicated finance store without changing global process state. */
export function resolveFinanceCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const file = path.join(resolveStateDir(env), "finance-caseflow", "credentials.env");
  let stored: Record<string, string>;
  try {
    stored = dotenv.parse(fs.readFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...env };
    }
    throw new Error("finance credential store unreadable", { cause: error });
  }
  const resolved = { ...env };
  for (const key of FINANCE_CREDENTIAL_KEYS) {
    // An explicitly supplied empty variable disables that credential.
    if (env[key] === undefined && stored[key] !== undefined) {
      resolved[key] = stored[key];
    }
  }
  return resolved;
}
