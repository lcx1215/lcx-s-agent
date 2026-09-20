/**
 * Output-side grounding gate for composed finance answers.
 *
 * The composer already grounds the *input*: `buildGroundingContext` hands the model only numbers
 * that carry a source and a timestamp. Nothing checks the *output*. A model that was given good
 * numbers can still write a plausible one it was never given, and a reader cannot tell that
 * number apart from an observed one.
 *
 * This gate does not try to infer what a number means from the words around it. That approach was
 * tried and abandoned elsewhere: a catalogue of phrasings grows a fix commit per wording and can
 * give a sentence and its translation different verdicts. Instead the model declares the kind of
 * every figure it used, in a machine-readable block, and this gate only does mechanical
 * comparison against the snapshot the model was grounded on.
 *
 * Deliberately non-destructive: it reports and does not rewrite the answer. Redacting figures in
 * prose edits text the gate cannot fully understand, and an edit that hits the wrong occurrence is
 * worse than an honest failure. The caller decides whether to rewrite, mark, or refuse.
 *
 * Absence of a declaration block is a failure, not a pass: an answer that cannot be checked is
 * reported as unverifiable rather than quietly adopted.
 */

import { calculationNumbers, type CalculationRecord } from "./finance-calculation-ledger.js";
import type { FinanceDataGatewaySnapshot } from "./finance-data-gateway.js";

export const FIGURE_KINDS = ["observed", "derived", "proposed", "cited", "count"] as const;

export type FigureKind = (typeof FIGURE_KINDS)[number];

export type FigureDeclaration = Readonly<{
  kind: FigureKind;
  name?: string;
  value: string | number;
  unit?: string;
}>;

export type GroundingGateVerdict =
  /** Every declared observation matched the snapshot. */
  | "verified"
  /** At least one declared observation is not in the snapshot. */
  | "ungrounded"
  /**
   * Every declaration checked out, but the prose contains value-shaped numbers that no declaration
   * accounts for. See `undeclaredProseValues`.
   */
  | "undeclared_figures"
  /** No usable declaration block, so nothing could be checked. Not a pass. */
  | "not_verifiable"
  /** Observations were declared but there is no snapshot to check them against. */
  | "no_snapshot";

export type GroundingGateResult = Readonly<{
  verdict: GroundingGateVerdict;
  declarations: ReadonlyArray<FigureDeclaration>;
  grounded: ReadonlyArray<FigureDeclaration>;
  ungrounded: ReadonlyArray<FigureDeclaration>;
  /** Value-shaped numbers written in the prose that no declaration accounts for. */
  undeclared: ReadonlyArray<string>;
  reasons: ReadonlyArray<string>;
}>;

const FIGURE_BLOCK_PATTERN = /```figures\s*\n([\s\S]*?)```/u;

/** Every figures block, so a second one cannot hide figures from the gate. */
const FIGURE_BLOCK_PATTERN_ALL = /```figures[\s\S]*?```/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Parse the declared figures block, if the model produced one.
 *
 * Returns `undefined` for anything unusable — missing, unparseable, wrong shape. The caller turns
 * that into `not_verifiable` rather than treating it as "no claims to check", because a model that
 * silently stops declaring is exactly how this gate would stop working.
 */
export function extractFigureDeclarations(answerText: string): FigureDeclaration[] | undefined {
  const match = FIGURE_BLOCK_PATTERN.exec(answerText);
  if (!match) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  const rows: unknown[] =
    isRecord(parsed) && Array.isArray(parsed.figures)
      ? parsed.figures
      : Array.isArray(parsed)
        ? parsed
        : [];
  if (rows.length === 0) {
    return undefined;
  }

  const out: FigureDeclaration[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      return undefined;
    }
    const kind = row.kind;
    if (typeof kind !== "string" || !(FIGURE_KINDS as readonly string[]).includes(kind)) {
      return undefined;
    }
    const value = row.value;
    if (typeof value !== "string" && typeof value !== "number") {
      return undefined;
    }
    out.push({
      kind: kind as FigureKind,
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}),
      value,
      ...(typeof row.unit === "string" && row.unit.trim() ? { unit: row.unit.trim() } : {}),
    });
  }
  return out;
}

/**
 * Normalize a number-bearing string for comparison.
 *
 * Thousands separators matter here: `1,309.22` and `1309.22` are the same observation, and a
 * comparison that treated them as different would flag a correctly cited price as fabricated.
 */
function normalizeComparable(value: string | number): string {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!raw) {
    return "";
  }
  const withoutSeparators = raw.replace(/[,\s_]/gu, "");
  const asNumber = Number(withoutSeparators);
  if (Number.isFinite(asNumber)) {
    // Significant digits, not decimal places. toFixed(9) fixed nine decimal *places*, so every
    // value below about 5e-10 rendered as "0.000000000": a snapshot field of 1e-11 — a wei, or
    // any micro-denominated amount — compared equal to a declared figure of 0, or of 2e-11, and
    // the gate reported as verified a number the snapshot had never contained. Ten significant
    // digits keeps the tolerance that lets 212.44 and 212.4400000001 compare equal while telling
    // small values apart from each other and from zero.
    // Zero needs no special case: (-0).toExponential(9) is "0.000000000e+0", the same string as
    // (0).toExponential(9), so signed zero already folds onto zero here.
    return `n:${asNumber.toExponential(9)}`;
  }
  return `s:${withoutSeparators.toLowerCase()}`;
}

/**
 * Value-shaped numbers written in the prose that no declaration accounts for.
 *
 * The module contract is that the model declares the kind of *every* figure it used, but only the
 * declarations were checked -- the prose was never cross-checked against them, so an answer could
 * declare a figure it was given and write a different one beside it. Measured against a snapshot
 * holding 480:
 *
 *   prose "NVDA 当前价格是 999 美元。" + block declaring 480          -> verified
 *   prose "…480 美元，市值是 11800 亿美元。" + block declaring 480    -> verified
 *   a second figures block declaring a fabricated 999                -> verified
 *
 * Under-declaring is the one shape this gate could not see, and it is the shape a model takes when
 * it wants to write a number it was not given. The check stays mechanical: pull value-shaped tokens
 * out of the prose, drop the declaration blocks themselves and the digits that are part of a name or
 * a label, and require every remaining value to match some declaration.
 *
 * "Value-shaped" means the token carries a unit, a decimal point or a thousands separator. A bare
 * integer is usually structure ("分三步"), and demanding a declaration for those would reject honest
 * prose -- the same distinction `extractDataNumbers` in `quality-harness-quality.ts` makes.
 */
/** Any digit run in the reader's own message, normalized for comparison. */
function suppliedNumbers(askText: string): Set<string> {
  const out = new Set<string>();
  for (const match of askText.matchAll(/\d[\d,]*(?:\.\d+)?/gu)) {
    out.add(normalizeComparable(match[0]));
  }
  return out;
}

function undeclaredProseValues(
  answerText: string,
  declarations: readonly FigureDeclaration[],
  askText?: string,
): string[] {
  const prose = answerText
    .replace(FIGURE_BLOCK_PATTERN_ALL, " ")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(
      /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T ][0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/giu,
      " ",
    )
    .replace(/\b20\d{2}年\d{1,2}月\d{1,2}日?/gu, " ")
    .replace(
      /(?:沪深|中证|上证|深证|创业板|科创|北证|恒生|日经|富时|标普|纳斯达克|道琼斯|国企|罗素)\d{1,4}(?!\d)/gu,
      " ",
    )
    .replace(/\b(?:S&P|SP|NASDAQ|RUSSELL|MSCI)[\s-]*\d{1,4}(?!\d)/giu, " ")
    .replace(/\b\d{1,2}(?:[YMWD]|年期?)(?!\d)/gu, " ")
    .replace(/\b(?:Q[1-4]|H[12]|FY\s?\d{2,4})\b/giu, " ");

  const declared = new Set(
    declarations.map((declaration) => normalizeComparable(declaration.value)),
  );
  // A number the reader supplied is not the answer inventing a figure -- the same exemption the
  // quality harness makes. The composer passes the ask through `askText`.
  const supplied = askText ? suppliedNumbers(askText) : new Set<string>();
  const out: string[] = [];
  const pattern =
    /(?<![\dA-Za-z])[+-]?\s*(?:[$€£¥]\s*)?((?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?)(\s*%|\s*(?:亿美元|亿元|万亿|美元|欧元|英镑|人民币|日元|USD|EUR|GBP|CNY|JPY|元|trillion|tn|billion|bn|million|mn))?/giu;
  for (const match of prose.matchAll(pattern)) {
    const numeric = match[1];
    const unit = (match[2] ?? "").trim();
    if (unit === "" && !/[.,]/u.test(numeric)) {
      continue;
    }
    const key = normalizeComparable(numeric);
    if (declared.has(key) || supplied.has(key)) {
      continue;
    }
    out.push(`${numeric}${unit ? ` ${unit}` : ""}`);
  }
  return [...new Set(out)];
}

export function collectObservedValues(snapshot: FinanceDataGatewaySnapshot): Set<string> {
  const out = new Set<string>();
  for (const field of snapshot.normalizedFields ?? []) {
    const key = normalizeComparable(field.value);
    if (key) {
      out.add(key);
    }
  }
  return out;
}

/**
 * Check a composed answer against the snapshot it was grounded on.
 *
 * Only `observed` figures are required to match. A derived ratio, a proposed target, a cited
 * third-party figure and a count are all legitimate things to write; requiring them to appear in
 * the snapshot would reject honest analysis. They are recorded, not rejected.
 */
/** The reason line for undeclared prose numbers, so every branch reports them the same way. */
function undeclaredReasons(undeclared: readonly string[]): string[] {
  if (undeclared.length === 0) {
    return [];
  }
  const shown = undeclared.slice(0, 8).join(", ");
  return [
    `${undeclared.length} value-shaped number(s) in the prose are not declared: ${shown}${
      undeclared.length > 8 ? ", …" : ""
    }`,
  ];
}

export function checkAnswerGrounding(params: {
  answerText: string;
  /**
   * The reader's own message. Numbers it contains are exempt from the undeclared-figures check:
   * a figure the reader supplied is not the answer inventing one.
   */
  askText?: string;
  snapshot?: FinanceDataGatewaySnapshot;
  /**
   * Calculations that ran while composing this answer.
   *
   * Supplying it upgrades `derived` figures from "recorded" to "checked": a number the model says
   * it computed must match a calculation that actually ran. Omitting it leaves `derived` unchecked
   * rather than failing, because a caller with no ledger has no way to distinguish "not computed"
   * from "computed elsewhere" and must not be forced into a false verdict.
   */
  calculations?: ReadonlyArray<CalculationRecord>;
}): GroundingGateResult {
  const declarations = extractFigureDeclarations(params.answerText);

  if (!declarations) {
    return {
      verdict: "not_verifiable",
      declarations: [],
      grounded: [],
      ungrounded: [],
      undeclared: [],
      reasons: [
        "no usable figures declaration block; the answer cannot be checked against the snapshot",
      ],
    };
  }

  // More than one block means the gate cannot tell which declaration set is authoritative, and
  // `extractFigureDeclarations` only reads the first -- so a second block could carry figures that
  // are never checked. Fail closed rather than guess.
  if ([...params.answerText.matchAll(FIGURE_BLOCK_PATTERN_ALL)].length > 1) {
    return {
      verdict: "not_verifiable",
      declarations,
      grounded: [],
      ungrounded: [],
      undeclared: undeclaredProseValues(params.answerText, declarations, params.askText),
      reasons: [
        "multiple figures declaration blocks; the gate cannot tell which one is authoritative",
      ],
    };
  }

  const undeclared = undeclaredProseValues(params.answerText, declarations, params.askText);

  const observed = declarations.filter((declaration) => declaration.kind === "observed");
  const derived = declarations.filter((declaration) => declaration.kind === "derived");

  const grounded: FigureDeclaration[] = [];
  const ungrounded: FigureDeclaration[] = [];
  const reasons: string[] = [];
  let derivedChecked = 0;

  // Derived figures are checked before the snapshot branches on purpose: they need the calculation
  // ledger, not the snapshot. Checking them afterwards would silently skip verification whenever
  // there is no snapshot, which is exactly when a computed figure most needs checking.
  // An empty ledger means "nothing was computed", the same as no ledger at all: those figures are
  // unverified, not fabricated. Treating the two differently would accuse every answer written
  // before the first calculation of inventing its numbers.
  const calculations =
    params.calculations && params.calculations.length > 0 ? params.calculations : undefined;
  if (calculations) {
    const calculated = new Set(
      calculations.flatMap((record) => calculationNumbers(record)).map(normalizeComparable),
    );
    for (const declaration of derived) {
      derivedChecked += 1;
      if (calculated.has(normalizeComparable(declaration.value))) {
        grounded.push(declaration);
      } else {
        ungrounded.push(declaration);
        reasons.push(
          `derived figure ${declaration.name ?? "(unnamed)"} = ${String(declaration.value)} does not match any recorded calculation`,
        );
      }
    }
  }

  if (observed.length > 0 && !params.snapshot) {
    return {
      verdict: "no_snapshot",
      declarations,
      grounded,
      ungrounded: [...ungrounded, ...observed],
      undeclared,
      reasons: [
        ...reasons,
        `declared ${observed.length} observed figure(s) but no snapshot exists to check them against`,
        ...undeclaredReasons(undeclared),
      ],
    };
  }

  if (!params.snapshot) {
    return {
      verdict:
        ungrounded.length > 0
          ? "ungrounded"
          : undeclared.length > 0
            ? "undeclared_figures"
            : "verified",
      declarations,
      grounded,
      ungrounded,
      undeclared,
      reasons: (() => {
        if (reasons.length > 0 || undeclared.length > 0) {
          return [...reasons, ...undeclaredReasons(undeclared)];
        }
        const unchecked = declarations.length - derivedChecked;
        return unchecked > 0
          ? [`${unchecked} declared figure(s) were recorded, not verified`]
          : ["no snapshot and no observed figures declared; nothing to contradict"];
      })(),
    };
  }

  const allowed = collectObservedValues(params.snapshot);

  for (const declaration of observed) {
    if (allowed.has(normalizeComparable(declaration.value))) {
      grounded.push(declaration);
    } else {
      ungrounded.push(declaration);
      reasons.push(
        `observed figure ${declaration.name ?? "(unnamed)"} = ${String(declaration.value)} is not present in the snapshot`,
      );
    }
  }

  const notChecked = declarations.length - observed.length - derivedChecked;
  if (notChecked > 0) {
    reasons.push(
      `${notChecked} declared figure(s) are not observations or checked derivations (proposed/cited/count, or derived without a ledger) and were recorded, not verified`,
    );
  }

  return {
    verdict:
      ungrounded.length > 0
        ? "ungrounded"
        : undeclared.length > 0
          ? "undeclared_figures"
          : "verified",
    declarations,
    grounded,
    ungrounded,
    undeclared,
    reasons: [...reasons, ...undeclaredReasons(undeclared)],
  };
}
