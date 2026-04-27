import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceFrameworkCoreContractPath,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_EVIDENCE_CATEGORIES,
  type FinanceFrameworkCoreContractArtifact,
  parseFinanceFrameworkCoreContractArtifact,
  renderFinanceFrameworkCoreContractArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNonGenericEvidenceSummary,
  validateFinanceDomainEvidenceGate,
} from "./finance-evidence-gates.js";

const FinanceFrameworkCoreRecordSchema = Type.Object({
  domain: stringEnum(FINANCE_FRAMEWORK_CORE_DOMAINS),
  sourceArtifacts: Type.Array(Type.String()),
  evidenceCategories: Type.Array(stringEnum(FINANCE_EVIDENCE_CATEGORIES)),
  evidenceSummary: Type.String(),
  baseCase: Type.String(),
  bullCase: Type.String(),
  bearCase: Type.String(),
  keyCausalChain: Type.String(),
  upstreamDrivers: Type.Array(Type.String()),
  downstreamAssetImpacts: Type.Array(Type.String()),
  confidenceOrConviction: stringEnum(FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS),
  whatChangesMyMind: Type.String(),
  noActionReason: Type.String(),
  riskGateNotes: Type.String(),
  allowedActionAuthority: stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES),
});

function normalizeRequiredText(params: Record<string, unknown>, key: string, label = key): string {
  const normalized = readStringParam(params, key, { required: true })
    .trim()
    .replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} must be non-empty`);
  }
  return normalized;
}

function normalizeStringList(params: Record<string, unknown>, key: string, label = key): string[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    throw new ToolInputError(`${label} must be an array of strings`);
  }
  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim().replace(/\r\n/gu, "\n") : ""))
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new ToolInputError(`${label} must contain at least one non-empty string`);
  }
  return normalized;
}

export type FinanceFrameworkCoreEntryInput =
  FinanceFrameworkCoreContractArtifact["entries"][number];

export async function writeFinanceFrameworkCoreEntry(params: {
  workspaceDir: string;
  entry: FinanceFrameworkCoreEntryInput;
}) {
  const contractRelPath = buildFinanceFrameworkCoreContractPath();
  const contractAbsPath = path.join(params.workspaceDir, contractRelPath);

  let parsedContract = undefined as
    | ReturnType<typeof parseFinanceFrameworkCoreContractArtifact>
    | undefined;
  try {
    parsedContract = parseFinanceFrameworkCoreContractArtifact(
      await fs.readFile(contractAbsPath, "utf8"),
    );
    if (!parsedContract) {
      return {
        ok: false,
        updated: false,
        reason: "finance_framework_core_contract_malformed",
        contractPath: contractRelPath,
        action:
          "Repair or archive the malformed finance framework core contract before retrying finance_framework_core_record.",
      } as const;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const nextEntries = new Map(parsedContract?.entries.map((entry) => [entry.domain, entry]) ?? []);
  nextEntries.set(params.entry.domain, params.entry);

  await fs.mkdir(path.dirname(contractAbsPath), { recursive: true });
  await fs.writeFile(
    contractAbsPath,
    renderFinanceFrameworkCoreContractArtifact({
      updatedAt: new Date().toISOString(),
      entries: [...nextEntries.values()].toSorted((left, right) =>
        left.domain.localeCompare(right.domain),
      ),
    }),
    "utf8",
  );

  return {
    ok: true,
    updated: true,
    domain: params.entry.domain,
    contractPath: contractRelPath,
    allowedActionAuthority: params.entry.allowedActionAuthority,
    confidenceOrConviction: params.entry.confidenceOrConviction,
    action:
      "This records bounded finance framework cognition only. It does not create trading execution authority, does not promote doctrine, and does not mutate doctrine cards automatically.",
  } as const;
}

export function createFinanceFrameworkCoreRecordTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Framework Core Record",
    name: "finance_framework_core_record",
    description:
      "Create or refresh one bounded finance framework core entry for a single domain. This writes a durable cross-domain cognition artifact only and never grants execution authority, promotes doctrine, or mutates doctrine cards automatically.",
    parameters: FinanceFrameworkCoreRecordSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const domain = normalizeRequiredText(params, "domain") as
        | (typeof FINANCE_FRAMEWORK_CORE_DOMAINS)[number]
        | undefined;
      if (!domain || !FINANCE_FRAMEWORK_CORE_DOMAINS.includes(domain)) {
        throw new ToolInputError(
          `domain must be one of: ${FINANCE_FRAMEWORK_CORE_DOMAINS.join(", ")}`,
        );
      }
      const sourceArtifacts = normalizeStringList(params, "sourceArtifacts", "sourceArtifacts");
      const evidenceCategories = normalizeStringList(
        params,
        "evidenceCategories",
        "evidenceCategories",
      );
      const evidenceSummary = normalizeRequiredText(params, "evidenceSummary", "evidenceSummary");
      ensureNonGenericEvidenceSummary(evidenceSummary, "evidenceSummary");
      const baseCase = normalizeRequiredText(params, "baseCase", "baseCase");
      const bullCase = normalizeRequiredText(params, "bullCase", "bullCase");
      const bearCase = normalizeRequiredText(params, "bearCase", "bearCase");
      const keyCausalChain = normalizeRequiredText(params, "keyCausalChain", "keyCausalChain");
      const upstreamDrivers = normalizeStringList(params, "upstreamDrivers", "upstreamDrivers");
      const downstreamAssetImpacts = normalizeStringList(
        params,
        "downstreamAssetImpacts",
        "downstreamAssetImpacts",
      );
      const confidenceOrConviction = normalizeRequiredText(
        params,
        "confidenceOrConviction",
        "confidenceOrConviction",
      ) as (typeof FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS)[number] | undefined;
      if (
        !confidenceOrConviction ||
        !FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS.includes(confidenceOrConviction)
      ) {
        throw new ToolInputError(
          `confidenceOrConviction must be one of: ${FINANCE_FRAMEWORK_CONFIDENCE_OR_CONVICTION_LEVELS.join(", ")}`,
        );
      }
      const whatChangesMyMind = normalizeRequiredText(
        params,
        "whatChangesMyMind",
        "whatChangesMyMind",
      );
      const noActionReason = normalizeRequiredText(params, "noActionReason", "noActionReason");
      const riskGateNotes = normalizeRequiredText(params, "riskGateNotes", "riskGateNotes");
      const allowedActionAuthority = normalizeRequiredText(
        params,
        "allowedActionAuthority",
        "allowedActionAuthority",
      ) as (typeof FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)[number] | undefined;
      if (
        !allowedActionAuthority ||
        !FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES.includes(allowedActionAuthority)
      ) {
        throw new ToolInputError(
          `allowedActionAuthority must be one of: ${FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES.join(", ")}`,
        );
      }
      validateFinanceDomainEvidenceGate({
        domain,
        evidenceCategories,
        evidenceSummary,
        keyCausalChain,
        upstreamDrivers,
        downstreamAssetImpacts,
      });

      return jsonResult(
        await writeFinanceFrameworkCoreEntry({
          workspaceDir,
          entry: {
            domain,
            sourceArtifacts,
            evidenceCategories:
              evidenceCategories as FinanceFrameworkCoreEntryInput["evidenceCategories"],
            evidenceSummary,
            baseCase,
            bullCase,
            bearCase,
            keyCausalChain,
            upstreamDrivers,
            downstreamAssetImpacts,
            confidenceOrConviction,
            whatChangesMyMind,
            noActionReason,
            riskGateNotes,
            allowedActionAuthority,
          },
        }),
      );
    },
  };
}
