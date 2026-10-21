import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ExternalMessageFlowRecord = {
  stage: "inbound" | "outbound_result";
  accountId: string;
  messageId: string;
  correlationId: string;
  conversationId: string;
  outboundMessageId?: string;
  deliveryStatus?: "success" | "failed";
};

/** Native transport receipts use the existing external-channel compatibility log contract. */
export async function appendExternalMessageFlow(
  record: ExternalMessageFlowRecord,
  logPath = process.env.LCX_REPLY_FLOW_LOG ??
    path.join(os.homedir(), ".openclaw", "logs", "external-message-flow.jsonl"),
): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const recordedAtMs = Date.now();
  // Deliberately omit message text, endpoint URLs, auth and transport error bodies.
  await fs.appendFile(
    logPath,
    `${JSON.stringify({ ...record, recordedAtMs, recordedAt: new Date(recordedAtMs).toISOString() })}\n`,
    { mode: 0o600 },
  );
}
