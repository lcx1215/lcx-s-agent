import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import {
  compactText,
  formatSessionTurns,
  generateArtifactSlug,
  loadSessionTurnsWithResetFallback,
  resolveMemorySessionContext,
  type SessionTurn,
} from "../artifact-memory.js";

const log = createSubsystemLogger("hooks/fundamental-intake");

const FUNDAMENTAL_KEYWORDS = [
  "fundamental",
  "financial report",
  "financial reports",
  "annual report",
  "quarterly report",
  "10-k",
  "10-q",
  "earnings",
  "investor presentation",
  "issuer",
  "watchlist",
  "company",
  "companies",
  "research report",
  "research reports",
  "financial statements",
  "财报",
  "年报",
  "季报",
  "研报",
  "公司",
  "基本面",
  "观察名单",
  "半导体",
  "基础设施",
];

const REGION_KEYWORDS = [
  { value: "china", keywords: ["china", "chinese", "中国"] },
  { value: "us", keywords: ["us", "u.s.", "united states", "america", "美国"] },
  { value: "europe", keywords: ["europe", "european", "eu", "欧洲"] },
  { value: "japan", keywords: ["japan", "japanese", "日本"] },
  { value: "global", keywords: ["global", "worldwide", "international", "全球", "all regions"] },
] as const;

type IntakePriority = "high" | "medium" | "low";
type AssetType = "equity" | "credit" | "fund" | "mixed";
type IssuerType = "public_company" | "financial_institution" | "sovereign" | "mixed_issuers";
export type DocumentType =
  | "annual_report"
  | "quarterly_report"
  | "interim_report"
  | "earnings_release"
  | "earnings_presentation"
  | "investor_presentation"
  | "regulatory_filing"
  | "research_report"
  | "transcript";
type SourceType =
  | "issuer_primary"
  | "regulatory_filing"
  | "exchange_disclosure"
  | "company_presentation"
  | "third_party_research";
export type FundamentalSourceType = SourceType;
export type ReviewGateMode = "human_approval_required" | "human_review_required";
export type FundamentalScaffoldStatus = "scaffold_only" | "partial" | "ready";
export type FundamentalReviewGateStatus =
  | "pending_human_approval"
  | "approved_for_collection"
  | "approved_for_evidence";
export type FundamentalRiskHandoffStatus =
  | "not_ready_for_risk_handoff"
  | "ready_for_fundamental_snapshot";
export type FundamentalDocumentPlanStatus = "missing" | "present";
export type FundamentalDocumentMetadata = {
  version: 1;
  targetLabel: string;
  category: DocumentType;
  sourceType: FundamentalSourceType;
  notes?: string[];
};
export type FundamentalDocumentConventions = {
  fileNamePattern: "<target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext>";
  metadataSidecarSuffix: ".meta.json";
  allowedExtensions: string[];
};

export type FundamentalIntakeSpec = {
  version: 1;
  generatedAt: string;
  requestTitle: string;
  regions: string[];
  targetEntities: string[];
  targetUniverse: string[];
  assetType: AssetType;
  issuerType: IssuerType;
  documentTypes: DocumentType[];
  priority: IntakePriority;
  sourcePolicy: {
    required: SourceType[];
    optional: SourceType[];
    forbidden: string[];
  };
  reviewGate: {
    mode: ReviewGateMode;
    approvalRequiredBeforeCollection: boolean;
    rationale: string;
  };
  notes: string[];
  rationale: string;
};

type ManifestTarget = {
  label: string;
  kind: "entity" | "universe_segment";
  region: string;
  assetType: AssetType;
  issuerType: IssuerType;
  resolution: "named" | "placeholder";
};

export type FundamentalDocumentWorkspace = {
  baseDir: string;
  targetDirs: Array<{
    targetLabel: string;
    dir: string;
  }>;
};

export type FundamentalManifestScaffold = {
  version: 1;
  generatedAt: string;
  manifestId: string;
  requestTitle: string;
  researchBranch: "fundamental_research_branch";
  intakeRef: string;
  scaffoldStatus: FundamentalScaffoldStatus;
  targets: ManifestTarget[];
  documentWorkspace: FundamentalDocumentWorkspace;
  documentConventions: FundamentalDocumentConventions;
  documentPlan: Array<{
    category: DocumentType;
    required: boolean;
    preferredSources: SourceType[];
    status: FundamentalDocumentPlanStatus;
  }>;
  sourcePolicy: FundamentalIntakeSpec["sourcePolicy"];
  reviewGate: {
    mode: ReviewGateMode;
    approvalRequiredBeforeCollection: boolean;
    status: FundamentalReviewGateStatus;
  };
  collectionStatus: {
    documentsPresent: boolean;
    evidenceReady: boolean;
    requiredDocumentsExpected: number;
    requiredDocumentsPresent: number;
    optionalDocumentsPresent: number;
    notes: string[];
  };
  riskHandoff: {
    status: FundamentalRiskHandoffStatus;
    riskAuditPath: null;
    notes: string[];
  };
};

function looksLikeFundamentalIntakeSession(turns: SessionTurn[]): boolean {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  return FUNDAMENTAL_KEYWORDS.some((keyword) => joined.includes(keyword));
}

function normalizeList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function findLabeledValue(params: { turns: SessionTurn[]; labels: string[] }): string | undefined {
  const patterns = params.labels.map(
    (label) => new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：-]\\s*(.+)$`, "i"),
  );
  const lines = params.turns
    .flatMap((turn) =>
      turn.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .toReversed();

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern)?.[1]?.trim();
      if (match) {
        return match;
      }
    }
  }
  return undefined;
}

function inferRegions(turns: SessionTurn[]): string[] {
  const labeled = findLabeledValue({
    turns,
    labels: ["regions", "region", "地区", "区域"],
  });
  if (labeled) {
    const normalized = normalizeList(labeled).map((value) => value.toLowerCase());
    const matched = REGION_KEYWORDS.filter((entry) =>
      normalized.some((value) => entry.keywords.some((keyword) => value.includes(keyword))),
    ).map((entry) => entry.value);
    if (matched.length > 0) {
      return matched;
    }
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  const matched = REGION_KEYWORDS.filter((entry) =>
    entry.keywords.some((keyword) => joined.includes(keyword)),
  ).map((entry) => entry.value);
  return matched.length > 0 ? [...new Set(matched)] : ["global"];
}

function inferTargetUniverse(turns: SessionTurn[]): string[] {
  const labeled = findLabeledValue({
    turns,
    labels: ["target universe", "universe", "watchlist", "目标范围", "观察名单"],
  });
  if (labeled) {
    return normalizeList(labeled);
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  const universes = new Set<string>();
  if (joined.includes("giants") || joined.includes("leaders") || joined.includes("龙头")) {
    universes.add("important giants");
  }
  if (joined.includes("large-cap semis") || joined.includes("large cap semis")) {
    universes.add("large-cap semis");
  }
  if (joined.includes("ai infrastructure") || joined.includes("ai infra")) {
    universes.add("ai infrastructure names");
  }
  if (joined.includes("watchlist")) {
    universes.add("watchlist candidates");
  }
  return universes.size > 0 ? [...universes] : ["broad fundamental watchlist"];
}

function inferTargetEntities(turns: SessionTurn[]): string[] {
  const labeled = findLabeledValue({
    turns,
    labels: ["target entities", "entities", "companies", "issuers", "目标公司", "公司"],
  });
  if (labeled) {
    return normalizeList(labeled);
  }

  const joined = turns.map((turn) => turn.text).join("\n");
  const tickerMatches = [...joined.matchAll(/\b([A-Z]{2,5}(?:\.[A-Z]{1,2})?)\b/g)]
    .map((match) => match[1]?.trim())
    .filter(
      (value): value is string =>
        Boolean(value) && !["US", "USA", "EU", "AI", "TBD"].includes(value),
    );
  const companyMatches = [
    ...joined.matchAll(
      /\b([A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,3}\s+(?:Inc|Corp|Corporation|Ltd|PLC|Group|Holdings|Technologies|Systems))\b/g,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set([...companyMatches, ...tickerMatches])].slice(0, 8);
}

function inferAssetType(turns: SessionTurn[]): AssetType {
  const labeled = findLabeledValue({
    turns,
    labels: ["asset type", "资产类型"],
  })?.toLowerCase();
  if (labeled?.includes("credit")) {
    return "credit";
  }
  if (labeled?.includes("fund")) {
    return "fund";
  }
  if (labeled?.includes("mixed")) {
    return "mixed";
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (joined.includes("bond") || joined.includes("credit")) {
    return "credit";
  }
  return "equity";
}

function inferIssuerType(turns: SessionTurn[]): IssuerType {
  const labeled = findLabeledValue({
    turns,
    labels: ["issuer type", "issuer", "发行人类型", "主体类型"],
  })?.toLowerCase();
  if (labeled?.includes("bank") || labeled?.includes("financial")) {
    return "financial_institution";
  }
  if (labeled?.includes("sovereign")) {
    return "sovereign";
  }
  if (labeled?.includes("mixed")) {
    return "mixed_issuers";
  }
  return "public_company";
}

function inferDocumentTypes(turns: SessionTurn[]): DocumentType[] {
  const labeled = findLabeledValue({
    turns,
    labels: ["document types", "documents", "doc types", "文档类型", "文档"],
  })?.toLowerCase();
  const joined = [labeled, turns.map((turn) => turn.text.toLowerCase()).join("\n")]
    .filter(Boolean)
    .join("\n");
  const documentTypes = new Set<DocumentType>();

  if (joined.includes("financial report") || joined.includes("financial reports")) {
    documentTypes.add("annual_report");
    documentTypes.add("quarterly_report");
  }
  if (joined.includes("annual report") || joined.includes("10-k") || joined.includes("年报")) {
    documentTypes.add("annual_report");
  }
  if (joined.includes("quarterly report") || joined.includes("10-q") || joined.includes("季报")) {
    documentTypes.add("quarterly_report");
  }
  if (joined.includes("interim")) {
    documentTypes.add("interim_report");
  }
  if (joined.includes("earnings release") || joined.includes("earnings")) {
    documentTypes.add("earnings_release");
  }
  if (joined.includes("earnings presentation")) {
    documentTypes.add("earnings_presentation");
  }
  if (joined.includes("investor presentation")) {
    documentTypes.add("investor_presentation");
  }
  if (joined.includes("regulatory filing") || joined.includes("filing")) {
    documentTypes.add("regulatory_filing");
  }
  if (joined.includes("research report") || joined.includes("研报")) {
    documentTypes.add("research_report");
  }
  if (joined.includes("transcript")) {
    documentTypes.add("transcript");
  }

  if (documentTypes.size === 0) {
    documentTypes.add("annual_report");
    documentTypes.add("quarterly_report");
    documentTypes.add("research_report");
  }

  return [...documentTypes];
}

function inferPriority(turns: SessionTurn[]): IntakePriority {
  const labeled = findLabeledValue({
    turns,
    labels: ["priority", "优先级"],
  })?.toLowerCase();
  if (labeled === "low") {
    return "low";
  }
  if (labeled === "medium") {
    return "medium";
  }

  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  if (joined.includes("important") || joined.includes("critical") || joined.includes("优先")) {
    return "high";
  }
  return "medium";
}

function inferSourcePolicy(documentTypes: DocumentType[]): FundamentalIntakeSpec["sourcePolicy"] {
  const required = new Set<SourceType>(["issuer_primary"]);
  const optional = new Set<SourceType>(["third_party_research"]);

  if (
    documentTypes.includes("annual_report") ||
    documentTypes.includes("quarterly_report") ||
    documentTypes.includes("regulatory_filing")
  ) {
    required.add("regulatory_filing");
  }
  if (
    documentTypes.includes("earnings_presentation") ||
    documentTypes.includes("investor_presentation")
  ) {
    required.add("company_presentation");
  }
  if (documentTypes.includes("research_report")) {
    optional.add("exchange_disclosure");
  }

  return {
    required: [...required],
    optional: [...optional],
    forbidden: [
      "Do not treat frontier paper cards as fundamental evidence.",
      "Do not mark documents as present until they exist locally.",
    ],
  };
}

function inferReviewGate(turns: SessionTurn[]): FundamentalIntakeSpec["reviewGate"] {
  const joined = turns.map((turn) => turn.text.toLowerCase()).join("\n");
  const approvalRequired =
    joined.includes("approval") ||
    joined.includes("review gate") ||
    joined.includes("gate") ||
    joined.includes("审批") ||
    joined.includes("审核");
  return {
    mode: approvalRequired ? "human_approval_required" : "human_review_required",
    approvalRequiredBeforeCollection: true,
    rationale: approvalRequired
      ? "Human approval is required before any document collection or downstream evidence work."
      : "This intake remains a controlled scaffold and should be reviewed before collection.",
  };
}

function inferTitle(turns: SessionTurn[], targetUniverse: string[]): string {
  const labeled = findLabeledValue({
    turns,
    labels: ["title", "request title", "标题"],
  });
  if (labeled) {
    return compactText(labeled, 120);
  }

  const latestUser =
    turns.toReversed().find((turn) => turn.role === "user")?.text ?? turns[0]?.text ?? "";
  if (latestUser) {
    return compactText(latestUser, 120);
  }
  return `Fundamental intake for ${targetUniverse[0] ?? "watchlist"}`;
}

function inferRationale(turns: SessionTurn[], targetUniverse: string[]): string {
  const latestUser =
    turns.toReversed().find((turn) => turn.role === "user")?.text ?? turns[0]?.text ?? "";
  return compactText(
    latestUser ||
      `Build a controlled fundamental research scaffold for ${targetUniverse.join(", ")}.`,
    220,
  );
}

function buildIntakeNotes(params: {
  regions: string[];
  targetUniverse: string[];
  targetEntities: string[];
  documentTypes: DocumentType[];
}): string[] {
  const notes = [
    `Scope regions: ${params.regions.join(", ")}.`,
    `Universe focus: ${params.targetUniverse.join(", ")}.`,
    params.targetEntities.length > 0
      ? `Named entities already present: ${params.targetEntities.join(", ")}.`
      : "No named entities were provided; manifest keeps placeholders instead of pretending companies are already selected.",
  ];
  if (params.documentTypes.includes("research_report")) {
    notes.push(
      "Third-party research is optional support, not a replacement for issuer-primary documents.",
    );
  }
  return notes;
}

function slugifyLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildManifestId(
  spec: Pick<FundamentalIntakeSpec, "targetUniverse" | "requestTitle">,
): string {
  return slugifyLabel(spec.targetUniverse[0] ?? spec.requestTitle);
}

function buildManifestTargets(spec: FundamentalIntakeSpec): ManifestTarget[] {
  if (spec.targetEntities.length > 0) {
    return spec.targetEntities.map((entity, index) => ({
      label: entity,
      kind: "entity",
      region: spec.regions[index] ?? spec.regions[0] ?? "global",
      assetType: spec.assetType,
      issuerType: spec.issuerType,
      resolution: "named",
    }));
  }

  return spec.targetUniverse.flatMap((segment, index) => {
    const region = spec.regions[index] ?? spec.regions[0] ?? "global";
    return [
      {
        label: segment,
        kind: "universe_segment",
        region,
        assetType: spec.assetType,
        issuerType: spec.issuerType,
        resolution: "named",
      },
      {
        label: `TBD_${region.toUpperCase()}_${slugifyLabel(segment).replace(/-/g, "_").toUpperCase()}`,
        kind: "entity",
        region,
        assetType: spec.assetType,
        issuerType: spec.issuerType,
        resolution: "placeholder",
      },
    ];
  });
}

function buildDocumentWorkspace(params: {
  manifestId: string;
  targets: ManifestTarget[];
}): FundamentalDocumentWorkspace {
  return {
    baseDir: `bank/fundamental/documents/${params.manifestId}`,
    targetDirs: params.targets
      .filter((target) => target.kind === "entity")
      .map((target) => ({
        targetLabel: target.label,
        dir: `bank/fundamental/documents/${params.manifestId}/${slugifyLabel(target.label)}`,
      })),
  };
}

function buildDocumentPlan(
  spec: FundamentalIntakeSpec,
): FundamentalManifestScaffold["documentPlan"] {
  return spec.documentTypes.map((documentType) => {
    const preferredSources = new Set<SourceType>(spec.sourcePolicy.required);
    if (documentType === "research_report") {
      preferredSources.add("third_party_research");
    }
    if (documentType === "regulatory_filing") {
      preferredSources.add("regulatory_filing");
    }
    return {
      category: documentType,
      required: documentType !== "research_report",
      preferredSources: [...preferredSources],
      status: "missing",
    };
  });
}

function buildDocumentConventions(): FundamentalDocumentConventions {
  return {
    fileNamePattern: "<target-slug>--<document-category>--<source-type>--<YYYYMMDD>.<ext>",
    metadataSidecarSuffix: ".meta.json",
    allowedExtensions: ["pdf", "html", "md", "txt", "docx", "xlsx"],
  };
}

export function summarizeFundamentalIntakeSession(
  turns: SessionTurn[],
  nowIso: string,
): {
  intakeSpec: FundamentalIntakeSpec;
  manifestScaffold: FundamentalManifestScaffold;
} {
  const regions = inferRegions(turns);
  const targetUniverse = inferTargetUniverse(turns);
  const targetEntities = inferTargetEntities(turns);
  const documentTypes = inferDocumentTypes(turns);
  const intakeSpec: FundamentalIntakeSpec = {
    version: 1,
    generatedAt: nowIso,
    requestTitle: inferTitle(turns, targetUniverse),
    regions,
    targetEntities,
    targetUniverse,
    assetType: inferAssetType(turns),
    issuerType: inferIssuerType(turns),
    documentTypes,
    priority: inferPriority(turns),
    sourcePolicy: inferSourcePolicy(documentTypes),
    reviewGate: inferReviewGate(turns),
    notes: buildIntakeNotes({
      regions,
      targetUniverse,
      targetEntities,
      documentTypes,
    }),
    rationale: inferRationale(turns, targetUniverse),
  };

  const manifestId = buildManifestId(intakeSpec);
  const targets = buildManifestTargets(intakeSpec);
  const documentPlan = buildDocumentPlan(intakeSpec);
  const intakeRef = "filled-by-handler";
  const manifestScaffold: FundamentalManifestScaffold = {
    version: 1,
    generatedAt: nowIso,
    manifestId,
    requestTitle: intakeSpec.requestTitle,
    researchBranch: "fundamental_research_branch",
    intakeRef,
    scaffoldStatus: "scaffold_only",
    targets,
    documentWorkspace: buildDocumentWorkspace({
      manifestId,
      targets,
    }),
    documentConventions: buildDocumentConventions(),
    documentPlan,
    sourcePolicy: intakeSpec.sourcePolicy,
    reviewGate: {
      mode: intakeSpec.reviewGate.mode,
      approvalRequiredBeforeCollection: intakeSpec.reviewGate.approvalRequiredBeforeCollection,
      status: "pending_human_approval",
    },
    collectionStatus: {
      documentsPresent: false,
      evidenceReady: false,
      requiredDocumentsExpected:
        targets.filter((target) => target.kind === "entity").length *
        documentPlan.filter((plan) => plan.required).length,
      requiredDocumentsPresent: 0,
      optionalDocumentsPresent: 0,
      notes: [
        "Manifest scaffold only. No local documents are assumed to exist yet.",
        "Document collection must stay manifest-first and approval-gated.",
      ],
    },
    riskHandoff: {
      status: "not_ready_for_risk_handoff",
      riskAuditPath: null,
      notes: [
        "No evidence, snapshot, score, or penalty artifacts exist yet.",
        "Risk handoff remains blocked until approved documents are collected and reviewed.",
      ],
    },
  };

  return { intakeSpec, manifestScaffold };
}

function renderFundamentalIntakeNote(params: {
  dateStr: string;
  timeStr: string;
  sessionKey: string;
  sessionId?: string;
  intakeSpec: FundamentalIntakeSpec;
  manifestScaffold: FundamentalManifestScaffold;
  intakePath: string;
  manifestPath: string;
  turns: SessionTurn[];
}): string {
  return [
    `# Fundamental Intake: ${params.dateStr} ${params.timeStr} UTC`,
    "",
    `- **Session Key**: ${params.sessionKey}`,
    `- **Session ID**: ${params.sessionId ?? "unknown"}`,
    `- **Request Title**: ${params.intakeSpec.requestTitle}`,
    `- **Priority**: ${params.intakeSpec.priority}`,
    "",
    "## Intake Spec",
    `- regions: ${params.intakeSpec.regions.join(", ")}`,
    `- target_entities: ${params.intakeSpec.targetEntities.length > 0 ? params.intakeSpec.targetEntities.join(", ") : "none yet"}`,
    `- target_universe: ${params.intakeSpec.targetUniverse.join(", ")}`,
    `- asset_type: ${params.intakeSpec.assetType}`,
    `- issuer_type: ${params.intakeSpec.issuerType}`,
    `- document_types: ${params.intakeSpec.documentTypes.join(", ")}`,
    `- source_policy.required: ${params.intakeSpec.sourcePolicy.required.join(", ")}`,
    `- source_policy.optional: ${params.intakeSpec.sourcePolicy.optional.join(", ")}`,
    `- review_gate: ${params.intakeSpec.reviewGate.mode}`,
    `- rationale: ${params.intakeSpec.rationale}`,
    "",
    "## Manifest Scaffold",
    `- intake_path: ${params.intakePath}`,
    `- manifest_path: ${params.manifestPath}`,
    `- manifest_id: ${params.manifestScaffold.manifestId}`,
    `- scaffold_status: ${params.manifestScaffold.scaffoldStatus}`,
    `- document_workspace: ${params.manifestScaffold.documentWorkspace.baseDir}`,
    `- required_documents_expected: ${params.manifestScaffold.collectionStatus.requiredDocumentsExpected}`,
    `- file_name_pattern: ${params.manifestScaffold.documentConventions.fileNamePattern}`,
    `- metadata_sidecar_suffix: ${params.manifestScaffold.documentConventions.metadataSidecarSuffix}`,
    "- collection_status: documents missing until local files are added under approval",
    "- risk_handoff: not_ready_for_risk_handoff",
    "",
    "## Notes",
    ...params.intakeSpec.notes.map((note) => `- ${note}`),
    "",
    "## Session Trace",
    ...params.turns.slice(-8).map((turn) => `- ${turn.role}: ${compactText(turn.text, 160)}`),
    "",
  ].join("\n");
}

const saveFundamentalIntake: HookHandler = async (event) => {
  if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
    return;
  }

  try {
    const { cfg, workspaceDir, memoryDir, sessionId, sessionFile } =
      await resolveMemorySessionContext({
        event,
        fallbackToLatestNonReset: true,
      });
    if (!sessionFile) {
      return;
    }

    const turns = await loadSessionTurnsWithResetFallback(sessionFile, 20);
    if (!looksLikeFundamentalIntakeSession(turns)) {
      return;
    }

    const now = new Date(event.timestamp);
    const nowIso = now.toISOString();
    const dateStr = nowIso.split("T")[0];
    const timeStr = nowIso.split("T")[1].split(".")[0];
    const { intakeSpec, manifestScaffold } = summarizeFundamentalIntakeSession(turns, nowIso);
    const fallbackSlug = `fundamental-intake-${slugifyLabel(intakeSpec.targetUniverse[0] ?? intakeSpec.requestTitle)}`;
    const slug = await generateArtifactSlug({
      turns,
      cfg,
      slugPrefix: "fundamental-intake",
      fallbackSlug,
    });

    const intakeRelativePath = `bank/fundamental/intakes/${dateStr}-${slug}.json`;
    const manifestRelativePath = `bank/fundamental/manifests/${dateStr}-fundamental-manifest-${manifestScaffold.manifestId}.json`;
    const noteRelativePath = `${dateStr}-${slug}.md`;

    const finalManifest = {
      ...manifestScaffold,
      intakeRef: intakeRelativePath,
    } satisfies FundamentalManifestScaffold;

    await Promise.all([
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: intakeRelativePath,
        data: `${JSON.stringify(intakeSpec, null, 2)}\n`,
        encoding: "utf-8",
      }),
      writeFileWithinRoot({
        rootDir: workspaceDir,
        relativePath: manifestRelativePath,
        data: `${JSON.stringify(finalManifest, null, 2)}\n`,
        encoding: "utf-8",
      }),
      writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: noteRelativePath,
        data: renderFundamentalIntakeNote({
          dateStr,
          timeStr,
          sessionKey: event.sessionKey,
          sessionId,
          intakeSpec,
          manifestScaffold: finalManifest,
          intakePath: intakeRelativePath,
          manifestPath: manifestRelativePath,
          turns,
        }),
        encoding: "utf-8",
      }),
    ]);

    log.info(
      `Fundamental intake saved to ${path.join(memoryDir, noteRelativePath)} with scaffold ${manifestRelativePath}`,
    );
    log.debug("Fundamental intake summary", {
      requestTitle: intakeSpec.requestTitle,
      regions: intakeSpec.regions,
      targetUniverse: intakeSpec.targetUniverse,
      documentTypes: intakeSpec.documentTypes,
    });
    log.debug("Fundamental session transcript", { transcript: formatSessionTurns(turns) });
  } catch (err) {
    log.error("Failed to save fundamental intake", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default saveFundamentalIntake;
