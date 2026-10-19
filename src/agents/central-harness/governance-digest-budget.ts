const KEY_BUDGET_BYTES = 2048;
type Row = Record<string, unknown>;

function record(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Fit an already validated governance projection; this grants no evidence or action authority. */
export function fitGovernanceDigest(input: Readonly<Record<string, unknown>>): Readonly<Row> {
  const originalBytes = bytes(input);
  if (originalBytes <= KEY_BUDGET_BYTES) {
    return input;
  }
  const flow = record(input.flowHandoff);
  const cleanup = record(input.cleanupReview);
  const shadow = record(input.shadow);
  const reader = record(input.projectionReader);
  const selfRepair = record(input.selfRepairFeedback);
  const providerCouncil = record(input.providerCouncilRun);
  const optionalFields = [
    "parentRunId",
    "sourceSha256",
    "checkedAt",
    "nextAction",
    "shadow.experimentId",
    "shadow.checkedAt",
    "shadow.completion",
    "projectionReader.adapterId",
    "ownerResults",
    "cleanupReview.detailPointers",
    "selfRepairFeedback.sourceRunId",
    "selfRepairFeedback.sourceCheckedAt",
    "selfRepairFeedback.itemId",
    "selfRepairFeedback.mapPath",
    "selfRepairFeedback.mapSha256",
    "selfRepairFeedback.governanceSha256",
  ];
  const present = optionalFields.filter((field) => {
    const [key, child] = field.split(".");
    return child ? record(input[key])?.[child] !== undefined : input[key] !== undefined;
  });
  // The same essential facts survive every tier. Only textual precision changes.
  for (const textBudget of [96, 64, 48, 32, 16, 8, 1]) {
    let shortenedStrings = 0;
    const clip = (value: unknown, limit = textBudget): unknown => {
      if (typeof value !== "string") {
        return value === null ? null : undefined;
      }
      if (Buffer.byteLength(value, "utf8") <= limit) {
        return value;
      }
      shortenedStrings += 1;
      let kept = "";
      for (const character of value) {
        if (Buffer.byteLength(kept + character + "…", "utf8") > limit) {
          break;
        }
        kept += character;
      }
      return limit >= 3 ? kept + "…" : "";
    };
    const select = (source: Row, fields: readonly string[], stringLimit?: number) =>
      Object.fromEntries(
        fields
          .filter((key) => source[key] !== undefined)
          .map((key) => [
            key,
            typeof source[key] === "string"
              ? clip(
                  source[key],
                  [
                    "status",
                    "cycleStatus",
                    "proofLevel",
                    "semanticAdoption",
                    "semanticTruth",
                    "coverage",
                    "trialDecision",
                    "readStatus",
                  ].includes(key)
                    ? 64
                    : stringLimit,
                )
              : typeof source[key] === "boolean" ||
                  source[key] === null ||
                  count(source[key]) !== undefined
                ? source[key]
                : undefined,
          ]),
      );
    const result: Row = select(
      input,
      ["status", "reason", "ok", "cycleStatus", "releaseBlocked", "complete"],
      48,
    );
    if (Array.isArray(input.pendingOwners)) {
      result.pendingOwners = input.pendingOwners
        .filter((value) => typeof value === "string")
        .slice(0, 6)
        .map((value) => clip(value));
    }
    if (input.sourceBoundary !== undefined) {
      result.sourceBoundary = clip(input.sourceBoundary, 48);
    }
    for (const key of ["ownerFailures", "failedGates", "blockedGates"]) {
      if (Array.isArray(input[key])) {
        const values = input[key].filter((value): value is string => typeof value === "string");
        result[key] = values.slice(0, 6).map((value) => clip(value, Math.min(textBudget, 48)));
        result[`${key}Count`] = values.length;
        if (values.length > 6) {
          result[`${key}Omitted`] = values.length - 6;
        }
      }
    }
    if (flow) {
      const projected: Row = select(flow, [
        "status",
        "reason",
        "proofLevel",
        "semanticAdoption",
        "scenarios",
        "gapDetailsOmitted",
      ]);
      const counts = record(flow.counts);
      if (counts) {
        projected.counts = select(counts, ["verified", "normalBlock", "gaps", "notObserved"]);
      }
      const origins = record(flow.origins);
      if (origins) {
        projected.origins = select(origins, ["offlineFixture", "naturalReceipt"]);
      }
      if (Array.isArray(flow.gapDetails)) {
        const first = record(flow.gapDetails[0]);
        projected.gapDetails = first
          ? [select(first, ["scenarioId", "status", "owner", "reason"])]
          : [];
        if (count(flow.gapDetailsOmitted) !== undefined) {
          projected.gapDetailsOmitted =
            Number(flow.gapDetailsOmitted) + Math.max(0, flow.gapDetails.length - 1);
        } else {
          projected.gapDetailsOmittedStatus = "missing";
        }
      }
      result.flowHandoff = projected;
    }
    if (cleanup) {
      const projected: Row = select(cleanup, [
        "status",
        "reason",
        "count",
        "preserve",
        "unknown",
        "selectedCandidates",
        "omittedCandidates",
        "coverage",
        "semanticTruth",
        "cleanupAuthorized",
      ]);
      if (Array.isArray(cleanup.missingChecks)) {
        const checks = cleanup.missingChecks.filter(
          (value): value is string => typeof value === "string",
        );
        projected.missingChecks = checks.slice(0, 1).map((check) => clip(check));
        if (count(cleanup.missingChecksOmitted) !== undefined) {
          projected.missingChecksOmitted =
            Number(cleanup.missingChecksOmitted) + Math.max(0, checks.length - 1);
        } else {
          projected.missingChecksOmittedStatus = "missing";
        }
      }
      result.cleanupReview = projected;
    }
    if (providerCouncil) {
      result.providerCouncilRun = select(
        providerCouncil,
        [
          "timedOut",
          "failureCode",
          "cleanupStatus",
          "cancellationRequested",
          "remoteCancellation",
          "actionAuthority",
        ],
        64,
      );
    }
    if (shadow) {
      result.shadow = select(shadow, ["status", "trialDecision", "trialDecisionReason", "reason"]);
    }
    if (reader) {
      result.projectionReader = select(reader, ["readStatus", "blocked"]);
    }
    if (selfRepair) {
      const projected = select(selfRepair, [
        "status",
        "diagnostic",
        "diagnosticOmitted",
        "proofLevel",
        "semanticTruth",
        "actionAuthority",
        "candidateOnly",
        "reuseAllowed",
      ]);
      const blockers = Array.isArray(selfRepair.blockers)
        ? selfRepair.blockers.filter((value): value is string => typeof value === "string")
        : [];
      if (typeof selfRepair.diagnostic === "string") {
        const limit = Math.max(textBudget, 192);
        projected.diagnostic = clip(selfRepair.diagnostic, limit);
        projected.diagnosticOmitted =
          selfRepair.diagnosticOmitted === true ||
          Buffer.byteLength(selfRepair.diagnostic, "utf8") > limit;
      }
      projected.identityFieldsOmitted = Array.isArray(selfRepair.identityFieldsOmitted)
        ? selfRepair.identityFieldsOmitted.filter((value) => typeof value === "string").slice(0, 3)
        : [];
      projected.blockers = blockers.slice(0, 1).map((value) => clip(value));
      projected.blockersOmitted =
        (count(selfRepair.blockersOmitted) ?? 0) + Math.max(0, blockers.length - 1);
      result.selfRepairFeedback = projected;
    }
    const omitted = [...present];
    const metadata = () => {
      const feedback = record(result.selfRepairFeedback);
      if (feedback) {
        const originalOmissions = Array.isArray(selfRepair?.identityFieldsOmitted)
          ? selfRepair.identityFieldsOmitted.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        feedback.identityFieldsOmitted = [
          ...new Set([
            ...originalOmissions,
            ...omitted
              .filter((field) => field.startsWith("selfRepairFeedback."))
              .map((field) => field.slice("selfRepairFeedback.".length)),
          ]),
        ];
      }
      return {
        originalBytes,
        omittedFields: omitted.slice(0, 8),
        omittedFieldCount:
          omitted.length +
          Object.keys(input).filter((key) => !Object.hasOwn(result, key) && !present.includes(key))
            .length,
        shortenedStrings,
        reason: "per_key_2048_bytes",
        boundary: "projection_only",
      };
    };
    result.budgetProjection = metadata();
    if (bytes(result) > KEY_BUDGET_BYTES) {
      continue;
    }
    // Description and source pointers may use spare bytes only after all blockers fit.
    for (const field of present) {
      const [key, child] = field.split(".");
      const source = child ? record(input[key])?.[child] : input[key];
      const previous = result[key];
      const previousShortened = shortenedStrings;
      if (field === "ownerResults") {
        const owners = Array.isArray(source) ? source : [];
        result.ownerResults = [];
        result.ownerResultsOmitted = (count(input.ownerResultsOmitted) ?? 0) + owners.length;
        for (const item of owners.slice(0, 4)) {
          const owner = record(item);
          if (!owner) {
            continue;
          }
          const pointer = select(
            owner,
            [
              "ownerId",
              "status",
              "reason",
              "artifactId",
              "sourceSha256",
              "sourceObservedAt",
              "sourceTimeBasis",
            ],
            128,
          );
          const kept = result.ownerResults as Row[];
          kept.push(pointer);
          result.ownerResultsOmitted = Number(result.ownerResultsOmitted) - 1;
          if (bytes(result) > KEY_BUDGET_BYTES) {
            kept.pop();
            result.ownerResultsOmitted = Number(result.ownerResultsOmitted) + 1;
            break;
          }
        }
      } else if (field === "cleanupReview.detailPointers") {
        result[key] = {
          ...record(previous),
          detailPointers: {
            sourceReads: "/value/cleanupReview/sourceReads",
            dispositions: "/value/cleanupReview/dispositions",
          },
        };
      } else {
        // Identity is retained in full or explicitly omitted; a prefix is not a binding.
        const value =
          ["sourceSha256", "parentRunId"].includes(field) || key === "selfRepairFeedback"
            ? source
            : clip(source);
        result[key] = child ? { ...record(previous), [child]: value } : value;
      }
      const index = omitted.indexOf(field);
      omitted.splice(index, 1);
      result.budgetProjection = metadata();
      if (bytes(result) > KEY_BUDGET_BYTES) {
        if (previous === undefined) {
          delete result[key];
        } else {
          result[key] = previous;
        }
        if (field === "ownerResults") {
          delete result.ownerResultsOmitted;
        }
        omitted.splice(index, 0, field);
        shortenedStrings = previousShortened;
        result.budgetProjection = metadata();
      }
    }
    return result;
  }
  // Even malformed optional input cannot become a success or disappear silently.
  return {
    status: "unavailable",
    reason: "governance_digest_essential_facts_exceed_budget",
    ...(typeof input.releaseBlocked === "boolean" ? { releaseBlocked: input.releaseBlocked } : {}),
    budgetProjection: { originalBytes, essentialFactsUnavailable: true },
  };
}
