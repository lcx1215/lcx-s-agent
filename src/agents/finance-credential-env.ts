import fs from "node:fs";
import dotenv from "dotenv";
import { FINANCE_CONNECTOR_CREDENTIAL_KEYS } from "./finance-data-connectors.js";
import { financeCredentialsPath, resolveFinanceStateDir } from "./finance-state-dir.js";

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
  "LCX_ENABLE_YAHOO_PUBLIC_SOURCE",
  "LCX_ENABLE_YAHOO_PUBLIC_SOURCES",
  ...FINANCE_CONNECTOR_CREDENTIAL_KEYS,
] as const;

/** Read the existing dedicated finance store without changing global process state. */
export function resolveFinanceCredentialEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Same root as the finance ledgers: one plane, one directory.
  const file = financeCredentialsPath(resolveFinanceStateDir({ env }).directory);
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
