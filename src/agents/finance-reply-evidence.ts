import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { readFileWithinRoot } from "../infra/fs-safe.js";
import type { CommercialAnswerAuditRequest } from "./commercial-answer-reply-gate.js";
import { checkAnswerGrounding } from "./finance-answer-grounding-gate.js";
import type { FinanceDataGatewaySnapshot } from "./finance-data-gateway.js";
import { FINANCE_DECISION_MODES, type FinanceDecisionMode } from "./finance-decision-policy.js";

const MAX_CANDIDATE_BYTES = 12 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const REFERENCE = /```finance_evidence\s*\n([\s\S]*?)```/gu;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type ToolReceipt = { receiptPath?: string; receiptSha256?: string; error?: string };
export type FinanceReplyEvidenceDecision = {
  status: "not_observed" | "verified" | "blocked";
  text: string;
  reasons: string[];
  toolCallId?: string;
  receiptSha256?: string;
  snapshotPointer?: string;
  grounding?: ReturnType<typeof checkAnswerGrounding>;
  /** Host-only inputs read from the hash-pinned original receipt, never channel metadata. */
  auditInput?: CommercialAnswerAuditRequest["input"];
  auditInputGaps?: string[];
};

function selectOriginalAuditInput(
  native: Record<string, unknown>,
  snapshot: FinanceDataGatewaySnapshot,
): Pick<FinanceReplyEvidenceDecision, "auditInput" | "auditInputGaps"> {
  const mode = record(native.plan)?.decisionMode;
  // Old receipts keep their original behavior; missing mode cannot imply current authority.
  if (mode === undefined) {
    return {};
  }
  if (!(FINANCE_DECISION_MODES as readonly unknown[]).includes(mode)) {
    return { auditInputGaps: ["finance_original_decision_mode_invalid"] };
  }
  const input: NonNullable<CommercialAnswerAuditRequest["input"]> = {
    financeDecisionMode: mode as FinanceDecisionMode,
    snapshot,
  };
  if (mode !== "research_only") {
    const artifact = record(record(native.quality)?.finalArtifact);
    const claims = Array.isArray(artifact?.claims) ? artifact.claims.map(record) : [];
    const evidence = record(native.batch)?.committeeEvidence;
    if (
      !claims.length ||
      claims.some(
        (claim) =>
          !claim ||
          (claim.status !== "supported" && claim.status !== "uncertain") ||
          !Array.isArray(claim.evidenceIds) ||
          claim.evidenceIds.some((id) => typeof id !== "string"),
      ) ||
      !Array.isArray(evidence)
    ) {
      return { auditInputGaps: ["finance_original_candidate_context_not_observed"] };
    }
    const selectedClaims = claims.map((claim) => ({
      status: claim!.status as "supported" | "uncertain",
      evidenceIds: claim!.evidenceIds as string[],
    }));
    const cited = new Set(selectedClaims.flatMap((claim) => claim.evidenceIds));
    const selectedEvidence = evidence.map(record).filter((row) => cited.has(String(row?.id)));
    if (
      selectedEvidence.some((row) => typeof row?.id !== "string" || typeof row.text !== "string") ||
      [...cited].some((id) => !selectedEvidence.some((row) => row?.id === id))
    ) {
      return { auditInputGaps: ["finance_original_candidate_evidence_not_observed"] };
    }
    input.candidateContext = {
      claims: selectedClaims,
      evidence: selectedEvidence.map((row) => ({
        id: row!.id as string,
        text: row!.text as string,
      })),
      supportingAnalysis: record(artifact?.supportingAnalysis),
    };
  }
  // Do not silently truncate evidence or reread the whole rule/research library.
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_CANDIDATE_BYTES) {
    return { auditInputGaps: ["finance_original_audit_context_budget_exceeded"] };
  }
  return { auditInput: input };
}

/** Per invocation host readback. Tool payloads cannot declare their own run/session scope. */
export function createFinanceReplyEvidenceTracker(params: {
  workspaceDir: string;
  sessionKey?: string;
  signal?: AbortSignal;
}) {
  const receipts = new Map<string, ToolReceipt>();
  let runId: string | undefined;
  let generation = 0;
  let stopped = false;
  let failed: string[] | undefined;
  const block = (reasons: string[]): FinanceReplyEvidenceDecision => {
    failed ??= reasons;
    return {
      status: "blocked",
      text: `本次金融证据引用未通过核对：${failed.join("；")}。请核对该原回执的来源、质量和具体字段后再采用。`,
      reasons: failed,
    };
  };
  return {
    start(id: string) {
      // Fallback attempts are different runs; never carry an earlier attempt's evidence forward.
      if (runId !== id) {
        receipts.clear();
        failed = undefined;
        generation += 1;
      }
      runId = id;
    },
    observe(event: AgentEventPayload) {
      if (
        stopped ||
        params.signal?.aborted ||
        !runId ||
        event.runId !== runId ||
        !params.sessionKey ||
        event.sessionKey !== params.sessionKey ||
        event.stream !== "tool" ||
        event.data.phase !== "result" ||
        event.data.name !== "finance_research_run" ||
        typeof event.data.toolCallId !== "string"
      ) {
        return;
      }
      const details = record(record(event.data.result)?.details);
      if (receipts.size >= 8 && !receipts.has(event.data.toolCallId)) {
        return;
      }
      const previous = receipts.get(event.data.toolCallId);
      // An error or changed result for the same invocation cannot be overwritten by a late success.
      receipts.set(
        event.data.toolCallId,
        previous?.error
          ? previous
          : {
              receiptPath:
                typeof details?.receiptPath === "string" ? details.receiptPath : undefined,
              receiptSha256:
                typeof details?.receiptSha256 === "string" ? details.receiptSha256 : undefined,
              error: event.data.isError
                ? "finance_tool_failed"
                : previous
                  ? "finance_tool_result_repeated"
                  : undefined,
            },
      );
    },
    hasReceipt() {
      return receipts.size > 0;
    },
    stop() {
      stopped = true;
    },
    async check(answerText: string, askText: string): Promise<FinanceReplyEvidenceDecision> {
      const observedGeneration = generation;
      // An old read cannot certify a new invocation or mutate its sticky failure state.
      const scopeChanged = (): FinanceReplyEvidenceDecision => ({
        status: "blocked",
        text: "",
        reasons: ["finance_reply_scope_changed"],
      });
      const matches = [...answerText.matchAll(REFERENCE)];
      if (!matches.length && answerText.includes("```finance_evidence")) {
        return block(["finance_reply_reference_invalid"]);
      }
      if (!matches.length) {
        return {
          status: "not_observed",
          text: answerText,
          reasons: ["explicit_finance_reference_not_observed"],
        };
      }
      if (failed) {
        return block(failed);
      }
      if (stopped || params.signal?.aborted) {
        return block(["finance_reply_run_cancelled"]);
      }
      if (Buffer.byteLength(answerText) > MAX_CANDIDATE_BYTES) {
        return block(["finance_reply_candidate_budget_exceeded"]);
      }
      if (matches.length !== 1) {
        return block(["finance_reply_reference_ambiguous"]);
      }
      let reference: Record<string, unknown> | undefined;
      try {
        reference = record(JSON.parse(matches[0][1]));
      } catch {
        /* Explicit malformed reference fails. */
      }
      if (!reference || typeof reference.toolCallId !== "string") {
        return block(["finance_reply_reference_invalid"]);
      }
      const receipt = receipts.get(reference.toolCallId);
      if (!receipt) {
        return block(["finance_tool_result_not_observed_in_current_scope"]);
      }
      if (receipt.error) {
        return block([receipt.error]);
      }
      if (
        !receipt.receiptPath ||
        !receipt.receiptSha256 ||
        !/^[a-f\d]{64}$/u.test(receipt.receiptSha256)
      ) {
        return block(["finance_receipt_source_hash_not_observed"]);
      }
      if (reference.receiptSha256 !== receipt.receiptSha256) {
        return block(["finance_receipt_reference_hash_conflict"]);
      }
      const relativePath = path.relative(params.workspaceDir, receipt.receiptPath);
      if (!/^state\/finance-research-runs\/[^/]+\.json$/u.test(relativePath)) {
        return block(["finance_receipt_path_outside_original_owner"]);
      }
      let native: Record<string, unknown> | undefined;
      try {
        const original = await readFileWithinRoot({
          rootDir: params.workspaceDir,
          relativePath,
          maxBytes: MAX_RECEIPT_BYTES,
          rejectHardlinks: true,
        });
        if (generation !== observedGeneration) {
          return scopeChanged();
        }
        if (createHash("sha256").update(original.buffer).digest("hex") !== receipt.receiptSha256) {
          return block(["finance_receipt_source_hash_conflict"]);
        }
        native = record(JSON.parse(original.buffer.toString("utf8")));
      } catch {
        if (generation !== observedGeneration) {
          return scopeChanged();
        }
        return block(["finance_receipt_readback_unavailable"]);
      }
      if (stopped || params.signal?.aborted) {
        return block(["finance_reply_run_cancelled"]);
      }
      if (native?.boundary !== "finance_research_run_research_only") {
        return block(["finance_receipt_owner_invalid"]);
      }
      const gates = Array.isArray(native.gates) ? native.gates.map(record) : [];
      const originalFailures = gates.filter(
        (gate) => (gate?.id === "source" || gate?.id === "quality") && gate.passed !== true,
      );
      if (originalFailures.length) {
        return block(
          originalFailures.map((gate) => `${String(gate?.id)}_gate_failed:${String(gate?.reason)}`),
        );
      }
      if (
        !gates.some((gate) => gate?.id === "source" && gate.passed === true) ||
        !gates.some((gate) => gate?.id === "quality" && gate.passed === true) ||
        record(native.quality)?.status !== "verified"
      ) {
        return block(["finance_receipt_source_or_quality_not_verified"]);
      }
      const pointer =
        typeof reference.snapshotPointer === "string"
          ? /^\/batch\/jobs\/(0|[1-9]\d?)\/receipt\/snapshot$/u.exec(reference.snapshotPointer)
          : null;
      const jobs = record(native.batch)?.jobs;
      const snapshot =
        pointer && Array.isArray(jobs)
          ? record(record(record(jobs[Number(pointer[1])])?.receipt)?.snapshot)
          : undefined;
      if (
        !snapshot ||
        snapshot.boundary !== "finance_data_gateway_research_only" ||
        !Array.isArray(snapshot.normalizedFields) ||
        typeof snapshot.asOf !== "string"
      ) {
        return block(["finance_snapshot_exact_field_not_observed"]);
      }
      if (reference.instrument !== snapshot.instrument || reference.asOf !== snapshot.asOf) {
        return block(["finance_snapshot_instrument_or_time_conflict"]);
      }
      const accountId = record(record(native.plan)?.portfolioContext)?.accountId;
      if (
        (accountId !== undefined || reference.accountId !== undefined) &&
        reference.accountId !== accountId
      ) {
        return block(["finance_snapshot_account_conflict"]);
      }
      if (
        snapshot.normalizedFields.some((field) => {
          const row = record(field);
          return (
            !row ||
            typeof row.name !== "string" ||
            (typeof row.value !== "number" && typeof row.value !== "string") ||
            typeof row.sourceTimestamp !== "string" ||
            typeof row.sourceUrlOrArtifact !== "string"
          );
        })
      ) {
        return block(["finance_snapshot_field_contract_invalid"]);
      }
      const text = answerText.replace(REFERENCE, "").trim();
      const grounding = checkAnswerGrounding({
        answerText: text,
        askText,
        snapshot: snapshot as FinanceDataGatewaySnapshot,
      });
      if (grounding.verdict !== "verified") {
        return {
          ...block([`finance_grounding_${grounding.verdict}`, ...grounding.reasons]),
          grounding,
        };
      }
      return {
        status: "verified",
        text: text.replace(/```figures\s*\n[\s\S]*?```/gu, "").trim(),
        reasons: [],
        toolCallId: reference.toolCallId,
        receiptSha256: receipt.receiptSha256,
        snapshotPointer: String(reference.snapshotPointer),
        grounding,
        ...selectOriginalAuditInput(native, snapshot as FinanceDataGatewaySnapshot),
      };
    },
  };
}
