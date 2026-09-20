/**
 * Foundational statistics the rest of the quant stack assumes but nobody had written down.
 *
 * These are the questions that come before portfolio maths: is this series stationary, do these two
 * things move together, is the relationship stable, and — the one people get wrong most often — is a
 * significant result still significant once you admit you ran the test thirty times.
 *
 * Conventions, shared with `quant-math-advanced.ts`:
 * - a returns matrix is **one row per observation, one column per asset**;
 * - variance and covariance are **sample** statistics (n − 1), matching `quant-math-tool.ts`.
 *
 * Every number here is either an identity that can be checked or a test whose critical values are
 * stated. Nothing in this file reports a p-value it cannot compute.
 */

import { cholesky, inverseSpd, solveSpd } from "./quant-math-advanced.js";
import { incompleteBeta } from "./quant-math-inference.js";

export type Matrix = number[][];

/**
 * Reject non-finite input at the door.
 *
 * A NaN that enters a covariance matrix does not stay put: it propagates through every downstream
 * weight and risk number, and by the time it surfaces there is no stack left to trace it to. The
 * alternative failure — an exception naming the input — is strictly better than a plausible-looking
 * NaN, because a NaN is a number that will be read.
 */
function assertFiniteValues(values: readonly number[], label: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite value`);
    }
  }
}

function assertFiniteMatrix(matrix: Matrix, label: string): void {
  for (const row of matrix) {
    assertFiniteValues(row, label);
  }
}

// ---------------------------------------------------------------------------
// Covariance and correlation matrices
// ---------------------------------------------------------------------------

/**
 * Sample covariance matrix, n − 1 denominator.
 *
 * The n − 1 versus n choice is not cosmetic: with n daily observations the difference is ~0.1%, but
 * with the 20-observation windows people actually use on a new listing it is 5%, which is larger
 * than most of the effects being estimated.
 */
export function covarianceMatrix(returnsMatrix: Matrix): Matrix {
  if (returnsMatrix.length === 0) {
    throw new Error("returnsMatrix required");
  }
  const assets = returnsMatrix[0].length;
  if (returnsMatrix.some((row) => row.length !== assets)) {
    throw new Error("returnsMatrix rows must all have the same length");
  }
  assertFiniteMatrix(returnsMatrix, "returnsMatrix");
  if (returnsMatrix.length < 2) {
    throw new Error("at least two observations are required for a sample covariance");
  }
  const n = returnsMatrix.length;
  const means = Array.from({ length: assets }, () => 0);
  for (const row of returnsMatrix) {
    for (let i = 0; i < assets; i += 1) {
      means[i] += row[i];
    }
  }
  for (let i = 0; i < assets; i += 1) {
    means[i] /= n;
  }
  const covariance: Matrix = Array.from({ length: assets }, () =>
    Array.from({ length: assets }, () => 0),
  );
  for (const row of returnsMatrix) {
    for (let i = 0; i < assets; i += 1) {
      for (let j = i; j < assets; j += 1) {
        covariance[i][j] += (row[i] - means[i]) * (row[j] - means[j]);
      }
    }
  }
  for (let i = 0; i < assets; i += 1) {
    for (let j = i; j < assets; j += 1) {
      const value = covariance[i][j] / (n - 1);
      covariance[i][j] = value;
      covariance[j][i] = value;
    }
  }
  return covariance;
}

/** Sample correlation matrix. A zero-variance column correlates with nothing, not with everything. */
export function correlationMatrix(returnsMatrix: Matrix): Matrix {
  const covariance = covarianceMatrix(returnsMatrix);
  const assets = covariance.length;
  const correlation: Matrix = Array.from({ length: assets }, () =>
    Array.from({ length: assets }, () => 0),
  );
  for (let i = 0; i < assets; i += 1) {
    for (let j = 0; j < assets; j += 1) {
      const denominator = Math.sqrt(covariance[i][i] * covariance[j][j]);
      correlation[i][j] = denominator === 0 ? 0 : covariance[i][j] / denominator;
      if (i === j) {
        correlation[i][j] = denominator === 0 ? 0 : 1;
      }
    }
  }
  return correlation;
}

// ---------------------------------------------------------------------------
// Covariance shrinkage
// ---------------------------------------------------------------------------

export type ShrinkageResult = {
  covariance: Matrix;
  /** Weight on the structured target, 0 to 1. Near zero means the sample was already enough. */
  shrinkageIntensity: number;
  target: "scaled_identity";
  observations: number;
  assets: number;
  /** False when the raw sample covariance was singular, which is why shrinking was necessary. */
  sampleUsable: boolean;
  note: string;
};

/**
 * Ledoit–Wolf shrinkage of the sample covariance towards a scaled identity
 * (`F = m·I` with `m` the average variance), following Ledoit & Wolf (2004).
 *
 * Why this exists: a sample covariance with as many assets as observations is singular by
 * construction, and every optimiser downstream needs a positive definite matrix, so the toolkit
 * previously refused to run at all on exactly the shapes crypto data arrives in — 80 coins, 40 days.
 * Shrinking is the standard remedy, not a workaround: the shrunk matrix is positive definite
 * whenever any variance is non-zero, and the estimated intensity falls towards zero once the sample
 * is long enough that the sample covariance can speak for itself.
 *
 * The intensity is estimated from the sample, not chosen by the caller, so it cannot be tuned to
 * produce a flattering answer. `sampleUsable` reports whether the raw matrix would have worked, so
 * a caller who only wants shrinkage when it is needed can still tell.
 */
export function shrinkCovariance(params: { returnsMatrix: Matrix }): ShrinkageResult {
  const rows = params.returnsMatrix;
  const sample = covarianceMatrix(rows);
  const assets = sample.length;
  const observations = rows.length;

  let trace = 0;
  for (let i = 0; i < assets; i += 1) {
    trace += sample[i][i];
  }
  const meanVariance = trace / assets;
  if (!(meanVariance > 0)) {
    throw new Error("every asset has zero variance; there is nothing to shrink towards");
  }

  // ||S - F||^2: how far the sample sits from the structured target.
  let targetDistance = 0;
  for (let i = 0; i < assets; i += 1) {
    for (let j = 0; j < assets; j += 1) {
      const target = i === j ? meanVariance : 0;
      const difference = sample[i][j] - target;
      targetDistance += difference * difference;
    }
  }

  // (1/n^2) * sum_t ||x_t x_t' - S||^2: the estimation error the shrinkage is compensating for.
  const means = Array.from({ length: assets }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < assets; i += 1) {
      means[i] += row[i];
    }
  }
  for (let i = 0; i < assets; i += 1) {
    means[i] /= observations;
  }
  let estimationError = 0;
  for (const row of rows) {
    const demeaned = row.map((value, index) => value - means[index]);
    for (let i = 0; i < assets; i += 1) {
      for (let j = 0; j < assets; j += 1) {
        const difference = demeaned[i] * demeaned[j] - sample[i][j];
        estimationError += difference * difference;
      }
    }
  }

  const raw =
    targetDistance === 0 ? 0 : estimationError / (observations * observations) / targetDistance;
  const intensity = Math.min(1, Math.max(0, raw));

  const covariance: Matrix = Array.from({ length: assets }, () =>
    Array.from({ length: assets }, () => 0),
  );
  for (let i = 0; i < assets; i += 1) {
    for (let j = i; j < assets; j += 1) {
      const target = i === j ? meanVariance : 0;
      const value = intensity * target + (1 - intensity) * sample[i][j];
      covariance[i][j] = value;
      covariance[j][i] = value;
    }
  }

  return {
    covariance,
    shrinkageIntensity: intensity,
    target: "scaled_identity",
    observations,
    assets,
    sampleUsable: cholesky(sample) !== null,
    note: "Ledoit–Wolf shrinkage towards a scaled identity; the intensity is estimated from the sample and reported, not chosen. A high intensity means the sample is too short to estimate this many covariances, which is the honest answer, not a failure — collect more history or fewer assets.",
  };
}

// ---------------------------------------------------------------------------
// Ordinary least squares, shared by the tests below
// ---------------------------------------------------------------------------

export type OlsFit = {
  coefficients: number[];
  standardErrors: number[];
  tStatistics: number[];
  residualSumOfSquares: number;
  observations: number;
  regressors: number;
};

/**
 * OLS via the normal equations.
 *
 * Cholesky is used on purpose rather than a general solve: X'X is symmetric positive definite
 * whenever the regressors are independent, so a failure of the factorisation is the collinearity
 * signal, not a numerical accident. Reporting "no fit" beats silently returning NaN coefficients.
 */
export function olsFit(dependent: number[], regressors: number[][]): OlsFit {
  assertFiniteValues(dependent, "dependent");
  assertFiniteMatrix(regressors, "regressors");
  const n = dependent.length;
  const k = regressors.length;
  if (k === 0) {
    throw new Error("at least one regressor is required");
  }
  if (regressors.some((column) => column.length !== n)) {
    throw new Error("regressor lengths disagree with the dependent variable");
  }
  if (n <= k) {
    throw new Error(`not enough observations (${n}) for ${k} regressors`);
  }
  const xtx: Matrix = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
  const xty = Array.from({ length: k }, () => 0);
  for (let i = 0; i < k; i += 1) {
    for (let j = i; j < k; j += 1) {
      let sum = 0;
      for (let t = 0; t < n; t += 1) {
        sum += regressors[i][t] * regressors[j][t];
      }
      xtx[i][j] = sum;
      xtx[j][i] = sum;
    }
    let sum = 0;
    for (let t = 0; t < n; t += 1) {
      sum += regressors[i][t] * dependent[t];
    }
    xty[i] = sum;
  }
  if (!cholesky(xtx)) {
    throw new Error("regressors are collinear; the fit is not identified");
  }
  const coefficients = solveSpd(xtx, xty);
  let residualSumOfSquares = 0;
  for (let t = 0; t < n; t += 1) {
    let fitted = 0;
    for (let i = 0; i < k; i += 1) {
      fitted += coefficients[i] * regressors[i][t];
    }
    const residual = dependent[t] - fitted;
    residualSumOfSquares += residual * residual;
  }
  const sigmaSquared = residualSumOfSquares / (n - k);
  const inverse = inverseSpd(xtx);
  const standardErrors = coefficients.map((_value, index) =>
    Math.sqrt(Math.max(0, sigmaSquared * inverse[index][index])),
  );
  const tStatistics = coefficients.map((value, index) =>
    standardErrors[index] === 0 ? 0 : value / standardErrors[index],
  );
  return {
    coefficients,
    standardErrors,
    tStatistics,
    residualSumOfSquares,
    observations: n,
    regressors: k,
  };
}

/**
 * Upper tail of the F distribution: P(F > f) with `df1` numerator and `df2` denominator degrees of
 * freedom. Uses the incomplete beta identity, so it shares the verified beta path with the
 * Student-t p-values rather than introducing a second numerical method.
 */
export function fDistributionUpperTailP(f: number, df1: number, df2: number): number {
  // Two different situations were being folded into the same answer. A non-positive statistic
  // really does have an upper-tail probability of 1 — nothing is below it. But an uncomputable
  // statistic, or a test with no degrees of freedom, has no answer at all, and reporting 1 there
  // is not withholding a claim: it is the strongest possible claim in the other direction.
  if (df1 <= 0 || df2 <= 0) {
    throw new Error(`no F tail probability for ${df1} and ${df2} degrees of freedom`);
  }
  if (!Number.isFinite(f)) {
    throw new Error(`no F tail probability for a statistic of ${f}`);
  }
  if (f <= 0) {
    return 1;
  }
  // With z = df1*f / (df1*f + df2): P(F <= f) = I_z(df1/2, df2/2), so the upper tail is
  // 1 - I_z(df1/2, df2/2) = I_{1-z}(df2/2, df1/2). Note the shape parameters swap with the tail.
  const x = df2 / (df2 + df1 * f);
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return incompleteBeta(df2 / 2, df1 / 2, x);
}

// ---------------------------------------------------------------------------
// Stationarity
// ---------------------------------------------------------------------------

/**
 * Asymptotic Augmented Dickey–Fuller critical values (Fuller 1976, Table 8.5.2).
 *
 * These are the n → ∞ values. ADF critical values do shift with sample size (MacKinnon), and using
 * asymptotic ones on short windows over-rejects, so the result says so instead of implying a
 * precision it does not have. No p-value is invented: the test statistic against stated critical
 * values is the honest output.
 */
const ADF_CRITICAL_VALUES = {
  none: { "1%": -2.58, "5%": -1.95, "10%": -1.62 },
  drift: { "1%": -3.43, "5%": -2.86, "10%": -2.57 },
  trend: { "1%": -3.96, "5%": -3.41, "10%": -3.13 },
} as const;

export type AdfRegression = "none" | "drift" | "trend";

export type AdfResult = {
  observations: number;
  effectiveObservations: number;
  regression: AdfRegression;
  lagsUsed: number;
  statistic: number;
  criticalValues: { level: string; value: number }[];
  verdict: "stationary" | "unit_root" | "inconclusive";
  note: string;
};

/**
 * Augmented Dickey–Fuller test: regress Δy on lagged level, lagged differences, and (optionally) a
 * constant and trend, then test the lagged level's coefficient.
 *
 * The lag order is chosen by AIC over 0 … `maxLag` because under-fitting leaves serial correlation
 * in the residuals, which inflates the test statistic and manufactures false rejections.
 */
export function adfTest(params: {
  values: number[];
  regression?: AdfRegression;
  maxLag?: number;
}): AdfResult {
  const values = params.values;
  const regression = params.regression ?? "drift";
  if (values.length < 8) {
    throw new Error("adfTest needs at least 8 observations");
  }
  // Checked before the regression is built: a NaN reaching the design matrix is reported as
  // collinearity, which sends whoever hits it looking for a modelling problem that is not there.
  assertFiniteValues(values, "values");
  const maxLag = params.maxLag ?? Math.max(0, Math.floor(12 * Math.pow(values.length / 100, 0.25)));

  let best: { lags: number; statistic: number; aic: number; effective: number } | undefined;
  for (let lags = 0; lags <= maxLag; lags += 1) {
    const built = buildAdfRegression(values, regression, lags);
    if (!built) {
      continue;
    }
    const fit = olsFit(built.dependent, built.regressors);
    const aic =
      fit.observations *
        Math.log(Math.max(fit.residualSumOfSquares / fit.observations, 10 ** -300)) +
      2 * fit.regressors;
    const statistic = fit.tStatistics[built.levelIndex];
    if (!best || aic < best.aic) {
      best = { lags, statistic, aic, effective: fit.observations };
    }
  }
  if (!best) {
    throw new Error("adfTest could not fit any lag order");
  }

  const critical = ADF_CRITICAL_VALUES[regression];
  const criticalValues = [
    { level: "1%", value: critical["1%"] },
    { level: "5%", value: critical["5%"] },
    { level: "10%", value: critical["10%"] },
  ];
  // The alternative is stationarity, so rejection is on the left tail.
  const stationary = best.statistic < critical["5%"];
  const unitRoot = best.statistic > critical["10%"];
  const verdict: AdfResult["verdict"] = stationary
    ? "stationary"
    : unitRoot
      ? "unit_root"
      : "inconclusive";

  return {
    observations: values.length,
    effectiveObservations: best.effective,
    regression,
    lagsUsed: best.lags,
    statistic: best.statistic,
    criticalValues,
    verdict,
    note: "Asymptotic (Fuller 1976) critical values, not sample-size-adjusted MacKinnon values: short windows over-reject, so read 'stationary' on a long series. 'inconclusive' means rejection at 10% but not at 5%.",
  };
}

function buildAdfRegression(
  values: number[],
  regression: AdfRegression,
  lags: number,
): { dependent: number[]; regressors: number[][]; levelIndex: number } | undefined {
  const n = values.length;
  const differences: number[] = [];
  for (let t = 1; t < n; t += 1) {
    differences.push(values[t] - values[t - 1]);
  }
  // t runs from lags + 1 so that every lagged difference exists.
  const start = lags + 1;
  const end = n - 1;
  if (end - start + 1 < 8) {
    return undefined;
  }
  const dependent: number[] = [];
  const levelColumn: number[] = [];
  const trendColumn: number[] = [];
  const constantColumn: number[] = [];
  const differenceColumns: number[][] = Array.from({ length: lags }, () => [] as number[]);
  for (let t = start; t <= end; t += 1) {
    dependent.push(differences[t - 1]);
    levelColumn.push(values[t - 1]);
    constantColumn.push(1);
    trendColumn.push(t);
    for (let lag = 1; lag <= lags; lag += 1) {
      differenceColumns[lag - 1].push(differences[t - lag - 1]);
    }
  }
  const regressors: number[][] = [];
  if (regression !== "none") {
    regressors.push(constantColumn);
  }
  if (regression === "trend") {
    regressors.push(trendColumn);
  }
  const levelIndex = regressors.length;
  regressors.push(levelColumn);
  regressors.push(...differenceColumns);
  return { dependent, regressors, levelIndex };
}

// ---------------------------------------------------------------------------
// Multiple comparisons
// ---------------------------------------------------------------------------

export type MultipleTestingMethod = "bonferroni" | "benjamini_hochberg";

export type MultipleTestingResult = {
  method: MultipleTestingMethod;
  alpha: number;
  tests: number;
  adjusted: number[];
  rejected: boolean[];
  rawSignificant: number;
  adjustedSignificant: number;
  note: string;
};

/**
 * Correct a family of p-values for the fact that a family was tested.
 *
 * This is the guard the association tests need and did not have: `lead_lag_correlation` returns one
 * p-value per lag, and scanning twenty lags at α = 0.05 produces one "significant" result by
 * construction even when nothing is going on. Reporting `rawSignificant` alongside
 * `adjustedSignificant` makes that gap visible instead of hiding it inside a single verdict.
 */
export function adjustPValues(params: {
  pValues: number[];
  method?: MultipleTestingMethod;
  alpha?: number;
}): MultipleTestingResult {
  const pValues = params.pValues;
  assertFiniteValues(pValues, "pValues");
  if (pValues.length === 0) {
    throw new Error("pValues required");
  }
  const method = params.method ?? "benjamini_hochberg";
  const alpha = params.alpha ?? 0.05;
  // A p-value outside [0, 1] is not a p-value. The negative case is the dangerous one: it survives
  // the correction as a negative adjusted value, is compared against alpha, and is reported as
  // significant — the strongest possible claim, made from a number that cannot exist.
  for (const value of pValues) {
    if (value < 0 || value > 1) {
      throw new Error("pValues must each be between 0 and 1");
    }
  }
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error(`alpha must be between 0 and 1, received ${alpha}`);
  }
  const tests = pValues.length;

  let adjusted: number[];
  if (method === "bonferroni") {
    adjusted = pValues.map((value) => Math.min(1, value * tests));
  } else {
    // Benjamini–Hochberg: walk from the largest p-value down, enforcing monotonicity.
    const indexed = pValues
      .map((value, index) => ({ value, index }))
      .toSorted((a, b) => a.value - b.value);
    const result = Array.from({ length: tests }, () => 1);
    let running = 1;
    for (let position = tests - 1; position >= 0; position -= 1) {
      const rank = position + 1;
      running = Math.min(running, (indexed[position].value * tests) / rank);
      result[indexed[position].index] = Math.min(1, running);
    }
    adjusted = result;
  }

  const rejected = adjusted.map((value) => value <= alpha);
  return {
    method,
    alpha,
    tests,
    adjusted,
    rejected,
    rawSignificant: pValues.filter((value) => value <= alpha).length,
    adjustedSignificant: rejected.filter(Boolean).length,
    note:
      method === "bonferroni"
        ? "Bonferroni controls the family-wise error rate: it is the conservative choice when a single false positive is unacceptable."
        : "Benjamini–Hochberg controls the false discovery rate: the right default when many hypotheses are screened and some false positives are tolerable.",
  };
}

// ---------------------------------------------------------------------------
// Granger-style predictive precedence
// ---------------------------------------------------------------------------

export type GrangerResult = {
  lags: number;
  observations: number;
  fStatistic: number;
  pValue: number;
  df1: number;
  df2: number;
  residualRestricted: number;
  residualUnrestricted: number;
  predictivePrecedence: boolean;
  note: string;
};

/**
 * Does `x` help predict `y` beyond `y`'s own history?
 *
 * Called "causality" in the literature and misread as causation ever since. What an F-test on the
 * added lags actually establishes is predictive precedence: `x` moves first. Confounding by a third
 * series is invisible to this test, so the field name says what was established, not what was hoped.
 */
export function grangerCausality(params: {
  y: number[];
  x: number[];
  lags?: number;
}): GrangerResult {
  const { y, x } = params;
  const lags = params.lags ?? 1;
  assertFiniteValues(y, "y");
  assertFiniteValues(x, "x");
  if (y.length !== x.length) {
    throw new Error("series lengths disagree");
  }
  if (lags < 1) {
    throw new Error("lags must be at least 1");
  }
  const n = y.length;
  const start = lags;
  const rows = n - lags;
  if (rows <= 3 * lags + 2) {
    throw new Error(`not enough observations (${n}) for ${lags} lags`);
  }

  const dependent: number[] = [];
  const yColumns: number[][] = Array.from({ length: lags }, () => [] as number[]);
  const xColumns: number[][] = Array.from({ length: lags }, () => [] as number[]);
  for (let t = start; t < n; t += 1) {
    dependent.push(y[t]);
    for (let lag = 1; lag <= lags; lag += 1) {
      yColumns[lag - 1].push(y[t - lag]);
      xColumns[lag - 1].push(x[t - lag]);
    }
  }
  const constant = Array.from({ length: rows }, () => 1);
  const restricted = olsFit(dependent, [constant, ...yColumns]);
  const unrestricted = olsFit(dependent, [constant, ...yColumns, ...xColumns]);

  const df1 = lags;
  const df2 = unrestricted.observations - unrestricted.regressors;
  const improvement = (restricted.residualSumOfSquares - unrestricted.residualSumOfSquares) / df1;
  const perDf = unrestricted.residualSumOfSquares / df2;
  const fStatistic = perDf === 0 ? 0 : improvement / perDf;
  const pValue = fDistributionUpperTailP(fStatistic, df1, df2);

  return {
    lags,
    observations: unrestricted.observations,
    fStatistic,
    pValue,
    df1,
    df2,
    residualRestricted: restricted.residualSumOfSquares,
    residualUnrestricted: unrestricted.residualSumOfSquares,
    predictivePrecedence: pValue < 0.05,
    note: "Granger precedence is predictive, not causal: a third series driving both will produce a significant result here. Requires both series to be stationary; run adfTest first and difference if not.",
  };
}

// ---------------------------------------------------------------------------
// Rolling association
// ---------------------------------------------------------------------------

export type RollingCorrelation = {
  window: number;
  windows: number;
  correlations: number[];
  mean: number;
  min: number;
  max: number;
  range: number;
  /** Sign changes between the first and last window: a relationship that flips is not a relationship. */
  signFlips: number;
  unstable: boolean | null;
  note: string;
};

/**
 * Correlation over a moving window, because a single correlation over two years of crypto data is
 * usually the average of three different regimes and describes none of them.
 *
 * `unstable` is null unless the caller states a threshold: how much movement counts as instability
 * is a modelling judgement, and a number the tool invented is not a number the caller can defend.
 */
export function rollingCorrelation(params: {
  a: number[];
  b: number[];
  window: number;
  unstableRangeThreshold?: number;
}): RollingCorrelation {
  const { a, b } = params;
  const window = params.window;
  assertFiniteValues(a, "a");
  assertFiniteValues(b, "b");
  if (a.length !== b.length) {
    throw new Error("series lengths disagree");
  }
  if (window < 3) {
    throw new Error("window must be at least 3");
  }
  if (a.length < window) {
    throw new Error(`series length ${a.length} is shorter than the window ${window}`);
  }
  const correlations: number[] = [];
  for (let start = 0; start + window <= a.length; start += 1) {
    correlations.push(
      pearsonWindow(a.slice(start, start + window), b.slice(start, start + window)),
    );
  }
  let signFlips = 0;
  for (let i = 1; i < correlations.length; i += 1) {
    if (Math.sign(correlations[i]) !== Math.sign(correlations[i - 1])) {
      signFlips += 1;
    }
  }
  const min = Math.min(...correlations);
  const max = Math.max(...correlations);
  const range = max - min;
  const threshold = params.unstableRangeThreshold;
  return {
    window,
    windows: correlations.length,
    correlations,
    mean: correlations.reduce((sum, value) => sum + value, 0) / correlations.length,
    min,
    max,
    range,
    signFlips,
    unstable: threshold === undefined ? null : range > threshold,
    note: "Each window is an independent Pearson correlation with no significance attached; a window this short cannot support one. Use range and signFlips to judge stability, not the mean.",
  };
}

function pearsonWindow(a: number[], b: number[]): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) {
    return 0;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}
