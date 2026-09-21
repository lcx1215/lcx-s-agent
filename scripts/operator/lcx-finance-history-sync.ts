import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { syncAlpacaPaperHistory } from "../../src/agents/finance-alpaca-history-sync.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";

export async function runFinanceHistorySync(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      account: { type: "string" },
      after: { type: "string" },
      until: { type: "string" },
    },
    strict: true,
  });
  if (!values.dir || !values.account || !values.after || !values.until) {
    throw new Error(
      "requires --dir --account --after --until; paper GET-only raw history, no position reconciliation",
    );
  }
  const env = resolveFinanceCredentialEnv({ ...process.env, LCX_FINANCE_STATE_DIR: values.dir });
  const keyId = env.ALPACA_API_KEY_ID;
  const secretKey = env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error("Alpaca credentials unavailable");
  }
  const receipt = await syncAlpacaPaperHistory({
    directory: values.dir,
    accountId: values.account,
    after: values.after,
    until: values.until,
    credentials: { keyId, secretKey },
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.status === "raw_history_synced" ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFinanceHistorySync()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write("finance history sync failed; no orders submitted\n");
      process.exitCode = 1;
    });
}
