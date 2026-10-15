import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { openFileWithinRoot, readFileWithinRoot } from "../infra/fs-safe.js";
import { assertNoPathAliasEscape } from "../infra/path-alias-guards.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import { createArtifactMemoryRecallTool } from "./tools/artifact-memory-recall-tool.js";
import { createMemoryGetTool } from "./tools/memory-tool.js";

const memoryReference = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const selfRepairMemoryRecallSchema = z.object({
  previousReceipt: memoryReference,
  correction: memoryReference,
  artifact: z.object({ id: z.string().min(1), sha256: memoryReference.shape.sha256 }),
  from: z.number().int().min(1),
  lines: z.number().int().min(1).max(80),
});
export type SelfRepairMemoryRecallRequest = z.infer<typeof selfRepairMemoryRecallSchema>;
export type SelfRepairMemoryScope = { accountId: string; runId: string };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Read existing evidence, without registering replacement artifacts or deciding rule truth. */
export async function readSelfRepairMemoryRecall(options: {
  workspaceDir: string;
  request: SelfRepairMemoryRecallRequest;
  currentScope: SelfRepairMemoryScope;
  expectedMemoryScope?: SelfRepairMemoryScope;
  artifactStorePath?: string;
  replacementRule: string;
}) {
  const request = selfRepairMemoryRecallSchema.parse(options.request);
  const scope = options.expectedMemoryScope;
  if (!scope?.accountId || !scope.runId || !options.artifactStorePath) {
    throw new Error("self_repair_memory_host_missing");
  }
  if (!options.currentScope.accountId || scope.accountId !== options.currentScope.accountId) {
    throw new Error("self_repair_memory_account_mismatch");
  }
  const readPinned = async (
    role: "previous_receipt" | "correction" | "source",
    reference: { path: string; sha256: string },
  ) => {
    let buffer: Buffer;
    try {
      ({ buffer } = await readFileWithinRoot({
        rootDir: options.workspaceDir,
        relativePath: reference.path,
        maxBytes: 512 * 1024,
      }));
    } catch (error) {
      throw new Error(`self_repair_memory_unreadable:${role}:${reference.path}`, { cause: error });
    }
    if (hash(buffer) !== reference.sha256) {
      throw new Error(`self_repair_memory_source_hash_mismatch:${role}:${reference.path}`);
    }
    return buffer.toString("utf8");
  };
  const previous = z
    .object({
      kind: z.literal("lcx-self-repair-hands"),
      status: z.literal("write_completed"),
      candidateOnly: z.literal(true),
      reuseAllowed: z.literal(false),
      semanticTruth: z.literal("not_proven"),
      sourceReview: z.object({
        status: z.literal("verified_reference_candidate_only"),
        source: memoryReference,
        scope: z.object({ accountId: z.string(), runId: z.string() }),
      }),
      hands: z.object({
        memoryCleaner: z.object({ path: z.string(), correctionMarkdown: z.string() }),
        patchCandidateBuilder: z.object({
          candidate: z.object({ proposedPatchContract: z.object({ replacementRule: z.string() }) }),
        }),
      }),
    })
    .parse(JSON.parse(await readPinned("previous_receipt", request.previousReceipt)));
  if (
    previous.sourceReview.scope.accountId !== scope.accountId ||
    previous.sourceReview.scope.runId !== scope.runId
  ) {
    throw new Error("self_repair_memory_scope_mismatch");
  }
  const oldPath = path.relative(
    path.resolve(options.workspaceDir),
    path.resolve(previous.hands.memoryCleaner.path),
  );
  if (
    oldPath !== request.correction.path ||
    !/^memory\/self-repair\/correction-downrank\/[^/]+\.md$/u.test(oldPath)
  ) {
    throw new Error("self_repair_memory_correction_path_mismatch");
  }
  const oldBody = await readPinned("correction", request.correction);
  if (oldBody !== `${previous.hands.memoryCleaner.correctionMarkdown}\n`) {
    throw new Error("self_repair_memory_correction_body_mismatch");
  }
  const oldRule =
    previous.hands.patchCandidateBuilder.candidate.proposedPatchContract.replacementRule;
  if (readSelfRepairReplacementRule(oldBody, oldRule) !== oldRule) {
    throw new Error("self_repair_memory_old_rule_missing");
  }
  const oldSource = await readPinned("source", previous.sourceReview.source);
  const parsedOldSource = z
    .object({ observedAt: z.string() })
    .passthrough()
    .parse(JSON.parse(oldSource));
  const oldSourceAge = Date.now() - Date.parse(parsedOldSource.observedAt);
  if (parsedOldSource.replacementRule !== oldRule) {
    throw new Error("correction_replacement_rule_source_mismatch");
  }
  const verified = verifySelfRepairSourceContent({
    source: parsedOldSource,
    ...scope,
    replacementRule: oldRule,
    nowMs: Date.now(),
  });
  // Historical evidence is a provisional comparison, never current qualifying evidence.
  // Preserve scope/rule checks and reject future/invalid time, without vetoing stale-memory repair.
  if (
    !verified.ok &&
    !(
      verified.reason === "correction_source_not_fresh" &&
      oldSourceAge > SELF_REPAIR_SOURCE_FRESHNESS_MS
    )
  ) {
    throw new Error(verified.reason);
  }
  // The host selects an existing workspace DB. Never resolve global/provider configuration.
  const db = await openFileWithinRoot({
    rootDir: options.workspaceDir,
    relativePath: options.artifactStorePath,
  });
  const dbPath = db.realPath;
  await db.handle.close();
  await assertNoPathAliasEscape({
    absolutePath: dbPath,
    rootPath: options.workspaceDir,
    boundaryLabel: "self repair memory artifact store",
  });
  const config = {
    agents: {
      defaults: {
        workspace: options.workspaceDir,
        memorySearch: { enabled: true, store: { path: dbPath } },
      },
    },
  };
  const store = ArtifactStore.open({ dbPath, workspaceDir: options.workspaceDir, readOnly: true });
  let artifactPath: string;
  let artifactInvocation: { runId: string; workspaceId: string } | undefined;
  try {
    const original = await store.read(request.artifact.id, { completeJsonText: true });
    if (
      original.artifact.sha256 !== request.artifact.sha256 ||
      original.artifact.owner !== "memory_get" ||
      original.truncated ||
      original.text === undefined
    ) {
      throw new Error("self_repair_memory_artifact_reference_mismatch");
    }
    const envelope = z
      .object({
        schemaVersion: z.literal("lcx_agent_artifact_v1"),
        owner: z.literal("memory_get"),
        value: z.object({ path: z.string(), text: z.string() }),
        invocation: z.unknown().optional(),
      })
      .parse(JSON.parse(original.text));
    if (envelope.value.path !== oldPath) {
      throw new Error("self_repair_memory_artifact_path_mismatch");
    }
    if (envelope.invocation !== undefined) {
      const invocation = z
        .object({
          runId: z
            .string()
            .min(1)
            .refine(
              (value) =>
                value.trim() === value && Buffer.byteLength(value) <= 240 && !/\p{Cc}/u.test(value),
            ),
          workspaceId: memoryReference.shape.sha256,
        })
        .safeParse(envelope.invocation);
      if (!invocation.success) {
        throw new Error("self_repair_memory_artifact_invocation_invalid");
      }
      if (invocation.data.workspaceId !== hash(await fs.realpath(options.workspaceDir))) {
        throw new Error("self_repair_memory_artifact_workspace_mismatch");
      }
      artifactInvocation = invocation.data;
    }
    artifactPath = original.artifact.relativePath;
  } finally {
    store.close();
  }
  const recall = await createArtifactMemoryRecallTool({
    config,
    workspaceDir: options.workspaceDir,
  }).execute("self-repair-prewrite-recall", {
    action: "read",
    id: request.artifact.id,
    field: "/value/text",
  });
  const recalled = z
    .object({
      available: z.literal(true),
      sourceSha256: memoryReference.shape.sha256,
      field: z.literal("/value/text"),
      selectedValue: z.string(),
    })
    .safeParse(recall.details);
  if (!recalled.success || recalled.data.sourceSha256 !== request.artifact.sha256) {
    const failure = z.object({ gap: z.string() }).safeParse(recall.details);
    throw new Error(
      `self_repair_memory_selected_field_unavailable:${failure.success ? failure.data.gap : "invalid_reference"}`,
    );
  }
  const memoryGet = createMemoryGetTool({ config, readOnlyWorkspaceDir: options.workspaceDir });
  if (!memoryGet) {
    throw new Error("self_repair_memory_get_unavailable");
  }
  const live = await memoryGet.execute("self-repair-prewrite-memory-get", {
    path: oldPath,
    from: request.from,
    lines: request.lines,
  });
  const current = z
    .object({
      path: z.literal(oldPath),
      text: z.string(),
      missing: z.literal(false).optional(),
      disabled: z.literal(false).optional(),
    })
    .safeParse(live.details);
  const selectedText = recalled.data.selectedValue;
  if (!current.success || current.data.text !== selectedText) {
    throw new Error("self_repair_memory_selected_content_mismatch");
  }
  if (readSelfRepairReplacementRule(selectedText, oldRule) !== oldRule) {
    throw new Error("self_repair_memory_rule_not_fully_delivered");
  }
  // Recheck pinned memory after the tool reads; reference agreement is never semantic acceptance.
  await readPinned("previous_receipt", request.previousReceipt);
  await readPinned("source", previous.sourceReview.source);
  await readPinned("correction", request.correction);
  return {
    status: "read_candidate_only" as const,
    scope,
    previousReceipt: request.previousReceipt,
    source: previous.sourceReview.source,
    sourceObservedAt: parsedOldSource.observedAt,
    sourceUse: "historical_comparison_only" as const,
    correction: request.correction,
    artifact: {
      ...request.artifact,
      path: artifactPath,
      field: "/value/text" as const,
      ...(artifactInvocation ? { invocation: artifactInvocation } : {}),
    },
    from: request.from,
    lines: request.lines,
    selectedText,
    comparison:
      oldRule === options.replacementRule
        ? ("same_content" as const)
        : ("different_content_requires_review" as const),
    semanticTruth: "not_proven" as const,
    reuseAllowed: false as const,
    actionAuthority: false as const,
  };
}

/** Existing correction freshness boundary, shared by prewrite and postwrite consumers. */
export const SELF_REPAIR_SOURCE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

/** Read the whole original rendered field, preserving newlines and whitespace verbatim. */
export function readSelfRepairReplacementRule(body: string, declaredRule: string | undefined) {
  if (!declaredRule) {
    return undefined;
  }
  const prefix = "\n## Replacement Rule\n- ";
  const end = body.lastIndexOf("\n\n## Downrank Decision\n");
  const start = end - declaredRule.length;
  // The original writer's fixed closing section determines the field boundary; embedded
  // headings in a multiline rule are data. No trimming or first-line/substring acceptance.
  if (start < prefix.length || body.slice(start - prefix.length, start) !== prefix) {
    return undefined;
  }
  return body.slice(start, end);
}

export function verifySelfRepairSourceContent(params: {
  source: unknown;
  accountId: string | undefined;
  runId: string | undefined;
  replacementRule: string | undefined;
  nowMs: number;
}):
  | { ok: true; observedAt: string }
  | {
      ok: false;
      reason:
        | "correction_source_scope_mismatch"
        | "correction_source_not_fresh"
        | "correction_replacement_rule_source_mismatch";
    } {
  const source =
    params.source && typeof params.source === "object"
      ? (params.source as Record<string, unknown>)
      : undefined;
  const scope = source?.scope as Record<string, unknown> | undefined;
  if (
    !scope ||
    !params.accountId ||
    !params.runId ||
    scope.accountId !== params.accountId ||
    scope.runId !== params.runId
  ) {
    return { ok: false, reason: "correction_source_scope_mismatch" };
  }
  const observedAt = typeof source?.observedAt === "string" ? source.observedAt : "";
  const ageMs = params.nowMs - Date.parse(observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SELF_REPAIR_SOURCE_FRESHNESS_MS) {
    return { ok: false, reason: "correction_source_not_fresh" };
  }
  if (!params.replacementRule || params.replacementRule !== source?.replacementRule) {
    return { ok: false, reason: "correction_replacement_rule_source_mismatch" };
  }
  // This checks reference consistency, never source trust or correctness of the rule.
  return { ok: true, observedAt };
}
