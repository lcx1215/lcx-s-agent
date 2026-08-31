import {
  LOCAL_BRAIN_CONTRACT_HINTS,
  LOCAL_BRAIN_MODULE_TAXONOMY,
  LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS,
  LOCAL_BRAIN_RISK_BOUNDARIES,
} from "./local-brain-taxonomy.js";

/**
 * One prompt contract for every local-brain training row.
 *
 * Provenance belongs in the JSONL meta/receipt, not in the model-visible
 * prompt.  The distinction matters: a teacher or a receipt may know the
 * answer-bearing label, but the student must infer the contract from the
 * natural-language task and survive a neutral/holdout evaluation.
 */
export const LOCAL_BRAIN_TRAINING_PROMPT_VERSION =
  "local_brain_training_contract_v2_no_answer_bearing_source_summary";

const OUTPUT_FIELD_NAMES = [
  "task_family",
  "primary_modules",
  "supporting_modules",
  "required_tools",
  "missing_data",
  "risk_boundaries",
  "next_step",
  "rejected_context",
  "source_kind",
  "source_summary",
  "user_message",
  "candidate_text",
] as const;

const CONTRACT_LABELS = new Set<string>([
  ...LOCAL_BRAIN_MODULE_TAXONOMY,
  ...LOCAL_BRAIN_RISK_BOUNDARIES,
  ...OUTPUT_FIELD_NAMES,
]);

const ANSWER_BEARING_PREFIXES = new Set<string>([
  "acceptance",
  "case",
  "eval",
  "failure",
  "focus",
  "lark",
  "live",
  "minimax",
  "om",
  "receipt",
  "reply",
  "sync",
]);
const REDACTION_PLACEHOLDER_LABELS = new Set<string>([
  "withheld_case_label",
  "withheld_contract_id",
]);

const GENERIC_CONTRACT_ID_CHECK_PATTERN = /^\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b$/u;
const CONTRACT_TOKEN_PATTERN = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+\b/giu;
const CASE_LABEL_PATTERN = /\b(?:case|eval|id)\s*[:=]\s*[a-z0-9][a-z0-9_-]*/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeContractLabel(value: string): string {
  return value.toLowerCase().replace(/-/gu, "_");
}

/**
 * Return true for a token that can act as an answer-bearing contract label.
 *
 * Known taxonomy/output labels and legacy snake_case identifiers retain the
 * previous behavior.  Hyphenated prose is only withheld when it is clearly a
 * code-like token (an answer-bearing prefix or a digit-bearing multi-segment
 * identifier), so ordinary terms such as "high-level" remain readable.
 */
export function isAnswerBearingContractToken(value: string): boolean {
  const normalized = normalizeContractLabel(value);
  if (REDACTION_PLACEHOLDER_LABELS.has(normalized)) {
    return false;
  }
  if (CONTRACT_LABELS.has(normalized) || GENERIC_CONTRACT_ID_CHECK_PATTERN.test(value)) {
    return true;
  }
  const segments = normalized.split("_");
  return (
    segments.length >= 2 && (/[0-9]/u.test(value) || ANSWER_BEARING_PREFIXES.has(segments[0] ?? ""))
  );
}

/**
 * Find unique answer-bearing contract tokens in a model-visible text field.
 * This is shared by prompt redaction and the read-only dataset audit so the
 * two surfaces cannot silently disagree about hyphenated acceptance codes.
 */
export function findAnswerBearingContractTokens(input: string): string[] {
  const matches = input.match(CONTRACT_TOKEN_PATTERN) ?? [];
  return [...new Set(matches.filter(isAnswerBearingContractToken))];
}

/**
 * Remove answer-bearing identifiers from a teacher/student input while
 * retaining ordinary Chinese/English task semantics.  This is intentionally
 * conservative about prose: only known contract labels, legacy
 * multi-segment snake_case identifiers, and clearly code-like hyphenated
 * acceptance labels are withheld.
 */
export function redactTeacherContractLabels(input: string): string {
  let redacted = input.replace(CONTRACT_TOKEN_PATTERN, (value) =>
    isAnswerBearingContractToken(value) ? "<withheld_contract_id>" : value,
  );
  for (const label of [...CONTRACT_LABELS].toSorted((left, right) => right.length - left.length)) {
    redacted = redacted.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(label)}(?![A-Za-z0-9_])`, "giu"),
      "<withheld_contract_id>",
    );
  }
  redacted = redacted.replace(CASE_LABEL_PATTERN, "<withheld_case_label>");
  return redacted
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\r?\n/gu, " ")
    .trim();
}

export type LocalBrainTrainingPromptInput = {
  userAsk: string;
};

export function buildLocalBrainTrainingPrompt({ userAsk }: LocalBrainTrainingPromptInput): string {
  const safeUserAsk = redactTeacherContractLabels(userAsk);
  return [
    "You are the LCX Agent local auxiliary thought-flow model.",
    "Task: produce a concise control-room planning packet for the main agent.",
    "Do not answer the user's finance question directly.",
    "/no_think",
    "Do not emit chain-of-thought, markdown, or <think> blocks; output only the JSON object.",
    "Keep the JSON compact: short arrays, short next_step, no explanation inside or outside JSON.",
    `Output contract: ${LOCAL_BRAIN_OUTPUT_CONTRACT_HINTS.join(" ")}`,
    'Use this exact compact shape: {"task_family":"snake_case","primary_modules":[],"supporting_modules":[],"required_tools":[],"missing_data":[],"risk_boundaries":["research_only"],"next_step":"snake_case_action","rejected_context":["old_lark_conversation_history"]}',
    "Think like a careful human financial analyst: clarify objective, recall local memory and learned rules, split causal layers, identify missing evidence, route to review, then summarize for the control room.",
    "Do not invent current or timestamped market data, execution approval, or durable memory writes.",
    `Allowed module ids: ${LOCAL_BRAIN_MODULE_TAXONOMY.join(", ")}.`,
    "For finance tasks, choose concrete module ids from the allowed list instead of generic finance labels.",
    `Core planning hints: ${LOCAL_BRAIN_CONTRACT_HINTS.slice(0, 4).join(" ")}`,
    "Return only JSON with keys: task_family, primary_modules, supporting_modules, required_tools, missing_data, risk_boundaries, next_step, rejected_context.",
    `prompt_contract_version: ${LOCAL_BRAIN_TRAINING_PROMPT_VERSION}`,
    "Training provenance is withheld from the model-visible prompt; use only the natural-language task and keep provenance in meta/receipts.",
    `user_or_task: ${safeUserAsk}`,
  ].join("\n");
}
