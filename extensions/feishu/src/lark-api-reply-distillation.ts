import { createHash } from "node:crypto";

export type LarkApiReplyOutputKind =
  | "zh_text"
  | "en_text"
  | "mixed_text"
  | "code"
  | "json"
  | "token_like"
  | "binary"
  | "empty"
  | "unknown";

export type LarkApiReplyLearningDisposition =
  | "candidate_semantic_family"
  | "review_required"
  | "discard_secret"
  | "discard_binary"
  | "discard_empty";

export type LarkApiReplyDistillationSample = {
  outputKind: LarkApiReplyOutputKind;
  disposition: LarkApiReplyLearningDisposition;
  byteLength: number;
  contentHash: string;
  distillableText?: string;
  discardReason?: string;
};

const MAX_DISTILLABLE_CHARS = 1200;

function hashPayload(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function looksLikeSecretOrToken(value: string): boolean {
  const normalized = value.trim();
  return (
    /(?:bearer\s+)?(?:sk-[a-z0-9_-]{16,}|sk-ant-[a-z0-9_-]{16,}|sk-or-[a-z0-9_-]{16,})/iu.test(
      normalized,
    ) ||
    /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*["']?[a-z0-9._-]{16,}/iu.test(
      normalized,
    ) ||
    /^eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}$/.test(normalized)
  );
}

function looksLikeCode(value: string): boolean {
  return (
    /```[a-z0-9_-]*\n[\s\S]+```/iu.test(value) ||
    /\b(function|const|let|class|import|export|def|return|async|await)\b/u.test(value) ||
    /<\/?[a-z][\s\S]*>/iu.test(value)
  );
}

function tryJsonKind(value: string): "json" | undefined {
  const trimmed = value.trim();
  if (!/^[{[][\s\S]*[\]}]$/u.test(trimmed)) {
    return undefined;
  }
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    return undefined;
  }
}

function classifyText(value: string): LarkApiReplyOutputKind {
  if (value.trim().length === 0) {
    return "empty";
  }
  if (looksLikeSecretOrToken(value)) {
    return "token_like";
  }
  const jsonKind = tryJsonKind(value);
  if (jsonKind) {
    return jsonKind;
  }
  if (looksLikeCode(value)) {
    return "code";
  }
  const hasHan = /\p{Script=Han}/u.test(value);
  const hasLatin = /[a-z]/iu.test(value);
  if (hasHan && hasLatin) {
    return "mixed_text";
  }
  if (hasHan) {
    return "zh_text";
  }
  if (hasLatin) {
    return "en_text";
  }
  return "unknown";
}

function dispositionForKind(kind: LarkApiReplyOutputKind): LarkApiReplyLearningDisposition {
  if (kind === "empty") {
    return "discard_empty";
  }
  if (kind === "token_like") {
    return "discard_secret";
  }
  if (kind === "binary") {
    return "discard_binary";
  }
  if (kind === "unknown" || kind === "code" || kind === "json") {
    return "review_required";
  }
  return "candidate_semantic_family";
}

function discardReasonForKind(kind: LarkApiReplyOutputKind): string | undefined {
  if (kind === "empty") {
    return "empty API reply cannot teach routing semantics";
  }
  if (kind === "token_like") {
    return "token-like or secret-like output must not enter semantic memory";
  }
  if (kind === "binary") {
    return "binary payload is recorded only by hash and length";
  }
  return undefined;
}

export function normalizeLarkApiReplyForDistillation(
  payload: unknown,
): LarkApiReplyDistillationSample {
  if (payload instanceof Uint8Array) {
    return {
      outputKind: "binary",
      disposition: "discard_binary",
      byteLength: payload.byteLength,
      contentHash: hashPayload(payload),
      discardReason: discardReasonForKind("binary"),
    };
  }

  const text =
    typeof payload === "string"
      ? payload
      : payload === null || payload === undefined
        ? ""
        : JSON.stringify(payload);
  const normalized = normalizeText(text);
  const outputKind = classifyText(normalized);
  const disposition = dispositionForKind(outputKind);
  const canKeepText =
    disposition === "candidate_semantic_family" || disposition === "review_required";

  return {
    outputKind,
    disposition,
    byteLength: Buffer.byteLength(text),
    contentHash: hashPayload(text),
    distillableText: canKeepText ? normalized.slice(0, MAX_DISTILLABLE_CHARS) : undefined,
    discardReason: discardReasonForKind(outputKind),
  };
}
