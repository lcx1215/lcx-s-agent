/**
 * Association and significance primitives: the statistics that decide whether a relationship is
 * real.
 *
 * A correlation coefficient answers "how tight is the fit". It does not answer "is this
 * relationship there at all", and conflating the two is the most common way a plausible number
 * becomes a false conclusion. Every association here is returned with a p-value and a confidence
 * interval, so a reader can see whether the data actually supports the claim.
 *
 * Two failure modes are treated as first-class, because both are invisible if you only look at r:
 *
 *  1. **Spurious regression.** Non-stationary series (prices, cumulative counts) produce enormous
 *     R² against each other with no relationship whatsoever. `spuriousRegressionCheck` regresses
 *     both levels and differences and reports the gap, because a 0.99 R² on two trending series is
 *     a warning sign, not a finding.
 *  2. **Small-sample overclaiming.** With n=12 almost anything correlates at 0.5. The confidence
 *     interval is reported so the sample size is honest about itself.
 */

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    series += coefficients[j] / y;
  }
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) {
    d = tiny;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) {
      break;
    }
  }
  return h;
}

/** Regularised incomplete beta `I_x(a, b)`. */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for a Student-t statistic. */
export function studentTTwoTailedP(t: number, df: number): number {
  if (Number.isNaN(t) || df <= 0) {
    // There is no p-value to report: the statistic was never computable, or there are no degrees
    // of freedom to measure it against. Returning 1 would not withhold a claim, it would make the
    // strongest possible one in the other direction — "certainly no effect".
    throw new Error(`no p-value for a statistic of ${t} with ${df} degrees of freedom`);
  }
  // An infinite statistic arises from a perfect fit (zero residual variance). That is the strongest
  // possible evidence, not the weakest — returning 1 here would label an exact relationship
  // "indistinguishable from zero", which is precisely backwards.
  if (!Number.isFinite(t)) {
    return 0;
  }
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

// ---------------------------------------------------------------------------
// Correlation with inference
// ---------------------------------------------------------------------------

function rankify(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = Array.from({ length: values.length }, () => 0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) {
      j += 1;
    }
    // Average rank across ties.
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k].index] = averageRank;
    }
    i = j + 1;
  }
  return ranks;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
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

export type CorrelationTest = {
  n: number;
  pearson: number;
  spearman: number;
  kendallTau: number;
  /** Two-tailed p-value for the Pearson correlation. */
  pValue: number;
  /** Fisher-z 95% confidence interval for the Pearson correlation. */
  confidenceInterval95: [number, number];
  /** True when the correlation is not distinguishable from zero at 5%. */
  indistinguishableFromZero: boolean;
  /** True when n is too small for the interval to mean much. */
  smallSampleWarning: boolean;
};

export function correlationTest(a: number[], b: number[]): CorrelationTest {
  if (a.length !== b.length) {
    throw new Error("series lengths disagree");
  }
  const n = a.length;
  if (n < 4) {
    throw new Error("at least 4 paired observations required");
  }
  for (const value of [...a, ...b]) {
    if (!Number.isFinite(value)) {
      throw new Error("series contains a non-finite value");
    }
  }
  // A constant series has no variance, so every correlation with it is 0/0: undefined, not zero.
  // Kendall tau-b shows that as a NaN in the payload while Pearson reports a confident 0 with a
  // confidence interval, which is the worst combination available.
  if (a.every((value) => value === a[0]) || b.every((value) => value === b[0])) {
    throw new Error("a constant series has no correlation to measure");
  }

  const r = Math.max(-1, Math.min(1, pearson(a, b)));
  const spearman = pearson(rankify(a), rankify(b));

  // Kendall tau-b with tie handling.
  let concordant = 0;
  let discordant = 0;
  let tiesA = 0;
  let tiesB = 0;
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const da = a[i] - a[j];
      const db = b[i] - b[j];
      const sign = da * db;
      if (sign > 0) {
        concordant += 1;
      } else if (sign < 0) {
        discordant += 1;
      } else if (da === 0 && db === 0) {
        tiesA += 1;
        tiesB += 1;
      } else if (da === 0) {
        tiesA += 1;
      } else {
        tiesB += 1;
      }
    }
  }
  const pairCount = (n * (n - 1)) / 2;
  const kendallTau =
    pairCount === 0
      ? 0
      : (concordant - discordant) / Math.sqrt((pairCount - tiesA) * (pairCount - tiesB));

  // t-test on the correlation.
  const denom = 1 - r * r;
  const t = denom <= 0 ? Number.POSITIVE_INFINITY : r * Math.sqrt((n - 2) / denom);
  const pValue = Number.isFinite(t) ? studentTTwoTailedP(t, n - 2) : 0;

  // Fisher z interval; undefined with n < 4.
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const lower = Math.tanh(z - 1.96 * se);
  const upper = Math.tanh(z + 1.96 * se);

  return {
    n,
    pearson: r,
    spearman,
    kendallTau,
    pValue,
    confidenceInterval95: [lower, upper],
    indistinguishableFromZero: pValue > 0.05,
    smallSampleWarning: n < 30,
  };
}

// ---------------------------------------------------------------------------
// Regression with full diagnostics
// ---------------------------------------------------------------------------

export type RegressionDiagnostics = {
  n: number;
  slope: number;
  intercept: number;
  rSquared: number;
  /** Adjusted R², penalising extra regressors. */
  adjustedRSquared: number;
  slopeStdError: number;
  interceptStdError: number;
  slopeT: number;
  slopePValue: number;
  /** 95% confidence interval for the slope. */
  slopeConfidenceInterval95: [number, number];
  fStatistic: number;
  fPValue: number;
  residualStdError: number;
  durbinWatson: number;
  fitted: number[];
  residuals: number[];
};

/**
 * Ordinary least squares with the diagnostics that make a slope usable.
 *
 * `slope` alone is not a claim; `slopePValue` and the interval are. A beta of 1.3 on 10 daily
 * observations is not evidence of anything, and the interval is what shows that.
 */
export function regressionDiagnostics(x: number[], y: number[]): RegressionDiagnostics {
  for (const value of [...x, ...y]) {
    if (!Number.isFinite(value)) {
      throw new Error("regression inputs contain a non-finite value");
    }
  }
  const n = x.length;
  if (n !== y.length) {
    throw new Error("series lengths disagree");
  }
  if (n < 4) {
    throw new Error("at least 4 paired observations required");
  }
  const meanX = x.reduce((sum, value) => sum + value, 0) / n;
  const meanY = y.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) {
    throw new Error("regressor has zero variance");
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const fitted = x.map((value) => intercept + slope * value);
  const residuals = y.map((value, index) => value - fitted[index]);
  const sse = residuals.reduce((sum, value) => sum + value * value, 0);
  const df = n - 2;
  const residualStdError = Math.sqrt(sse / df);
  const slopeStdError = residualStdError / Math.sqrt(sxx);
  const interceptStdError = residualStdError * Math.sqrt(1 / n + (meanX * meanX) / sxx);
  const rSquared = syy === 0 ? 1 : 1 - sse / syy;
  // Zero standard error means an exact fit, i.e. an infinite t in the direction of the slope.
  // Collapsing it to 0 would report a perfect relationship as having no evidence at all.
  const slopeT =
    slopeStdError === 0
      ? slope === 0
        ? 0
        : Number.POSITIVE_INFINITY * Math.sign(slope)
      : slope / slopeStdError;
  const slopePValue = studentTTwoTailedP(slopeT, df);
  const tCritical = studentTCritical(0.975, df);
  const fStatistic =
    rSquared >= 1 ? Number.POSITIVE_INFINITY : rSquared / 1 / ((1 - rSquared) / df);

  let dwNumerator = 0;
  let dwDenominator = 0;
  for (let i = 1; i < n; i += 1) {
    dwNumerator += (residuals[i] - residuals[i - 1]) ** 2;
  }
  for (const value of residuals) {
    dwDenominator += value * value;
  }

  return {
    n,
    slope,
    intercept,
    rSquared,
    adjustedRSquared: 1 - (1 - rSquared) * ((n - 1) / df),
    slopeStdError,
    interceptStdError,
    slopeT,
    slopePValue,
    slopeConfidenceInterval95: [
      slope - tCritical * slopeStdError,
      slope + tCritical * slopeStdError,
    ],
    fStatistic,
    fPValue: Number.isFinite(fStatistic)
      ? 1 - incompleteBeta(df / 2, 0.5, df / (df + fStatistic))
      : 0,
    residualStdError,
    durbinWatson: dwDenominator === 0 ? 2 : dwNumerator / dwDenominator,
    fitted,
    residuals,
  };
}

/** Inverse Student-t CDF by bisection on the two-tailed tail probability. */
export function studentTCritical(probability: number, df: number): number {
  if (df <= 0) {
    throw new Error("degrees of freedom must be positive");
  }
  let low = 0;
  let high = 100;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    // P(T <= mid) = 1 - 0.5 * p_two_tailed(mid)
    const cdf = 1 - 0.5 * studentTTwoTailedP(mid, df);
    if (cdf < probability) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// Spurious regression guard
// ---------------------------------------------------------------------------

/**
 * Regress levels and first differences side by side.
 *
 * If R² collapses when you difference, the relationship was shared trend, not association. This is
 * the check that stops "BTC price correlates with the number of GitHub stars at r=0.97" from being
 * published as a finding.
 */
export function spuriousRegressionCheck(
  series: number[],
  other: number[],
): {
  levels: RegressionDiagnostics;
  differences: RegressionDiagnostics;
  rSquaredDrop: number;
  verdict: "likely_spurious" | "difference_relationship" | "level_relationship" | "inconclusive";
  explanation: string;
} {
  const levels = regressionDiagnostics(series, other);
  const diffSeries: number[] = [];
  const diffOther: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    diffSeries.push(series[i] - series[i - 1]);
    diffOther.push(other[i] - other[i - 1]);
  }
  const differences = regressionDiagnostics(diffSeries, diffOther);
  const rSquaredDrop = levels.rSquared - differences.rSquared;

  let verdict:
    | "likely_spurious"
    | "difference_relationship"
    | "level_relationship"
    | "inconclusive";
  let explanation: string;
  if (levels.rSquared > 0.8 && differences.rSquared < 0.2 && differences.slopePValue > 0.05) {
    verdict = "likely_spurious";
    explanation =
      `R² is ${levels.rSquared.toFixed(3)} on levels but ${differences.rSquared.toFixed(3)} on ` +
      "first differences with an insignificant slope: the fit is driven by shared trend, not by " +
      "an association. Do not report the level relationship as a finding.";
  } else if (differences.slopePValue <= 0.05 && levels.slopePValue <= 0.05) {
    verdict = "difference_relationship";
    explanation =
      "Both levels and differences show a significant slope; the difference relationship is the " +
      "one that generalises. Prefer the difference slope for anything predictive.";
  } else if (differences.slopePValue <= 0.05) {
    verdict = "difference_relationship";
    explanation =
      "Only the differenced series has a significant slope, which is the expected signature of a " +
      "real co-movement between two non-stationary series.";
  } else if (levels.slopePValue <= 0.05) {
    verdict = "level_relationship";
    explanation =
      "The level relationship is significant and survives differencing, so it is unlikely to be " +
      "pure shared trend.";
  } else {
    verdict = "inconclusive";
    explanation =
      "Neither levels nor differences produce a significant slope. There is no evidence of an " +
      "association in this sample, which is a result, not a failure.";
  }
  return { levels, differences, rSquaredDrop, verdict, explanation };
}

// ---------------------------------------------------------------------------
// Lead-lag
// ---------------------------------------------------------------------------

/**
 * Cross-correlation at integer lags.
 *
 * `lag > 0` means `series` leads `other` (series shifted forward). Reporting the best lag without a
 * p-value invites overfitting to whichever lag happened to be largest, so each lag carries its own
 * test and the best lag is flagged when it is not significant.
 */
export function leadLagCorrelation(
  series: number[],
  other: number[],
  maxLag = 5,
): {
  bestLag: number;
  bestCorrelation: number;
  bestPValue: number;
  significant: boolean;
  byLag: Array<{ lag: number; correlation: number; pValue: number; n: number }>;
} {
  // Aligned series only, for the same reason correlationTest insists on it: truncating to the
  // overlap would give every lag a different sample size and report the largest one as the answer.
  if (series.length !== other.length) {
    throw new Error("series lengths disagree");
  }
  // A fractional lag indexes between observations, which surfaces several frames later as a
  // complaint that the data are non-finite — sending whoever hit it to look at their series
  // instead of at the argument they passed.
  if (!Number.isInteger(maxLag) || maxLag < 0) {
    throw new Error("maxLag must be a non-negative whole number");
  }
  const byLag: Array<{ lag: number; correlation: number; pValue: number; n: number }> = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < series.length; i += 1) {
      const j = i + lag;
      if (j >= 0 && j < other.length) {
        a.push(series[i]);
        b.push(other[j]);
      }
    }
    if (a.length < 4) {
      continue;
    }
    const test = correlationTest(a, b);
    byLag.push({ lag, correlation: test.pearson, pValue: test.pValue, n: test.n });
  }
  if (byLag.length === 0) {
    throw new Error("not enough overlapping observations for the requested lags");
  }
  // Prefer the strongest correlation, but only among lags that clear the significance bar;
  // otherwise the winner is whichever lag got lucky.
  const significantLags = byLag.filter((entry) => entry.pValue <= 0.05);
  const pool = significantLags.length > 0 ? significantLags : byLag;
  const best = pool.reduce((winner, entry) =>
    Math.abs(entry.correlation) > Math.abs(winner.correlation) ? entry : winner,
  );
  return {
    bestLag: best.lag,
    bestCorrelation: best.correlation,
    bestPValue: best.pValue,
    significant: best.pValue <= 0.05,
    byLag,
  };
}

// ---------------------------------------------------------------------------
// Event study
// ---------------------------------------------------------------------------

/**
 * Market-model event study.
 *
 * Abnormal return on event day `t` is `AR_t = R_t − (α + β R_m,t)` with α, β estimated on the
 * estimation window that precedes the event window. Cumulative abnormal return and its t-statistic
 * are what turn "the coin moved after the announcement" into a tested statement.
 */
export function eventStudy(params: {
  returns: number[];
  marketReturns: number[];
  estimationWindow: [number, number];
  eventWindow: [number, number];
}): {
  alpha: number;
  beta: number;
  abnormalReturns: number[];
  cumulativeAbnormalReturn: number;
  /** Cross-sectional t-statistic using the estimation-window residual volatility. */
  tStatistic: number;
  pValue: number;
  significant: boolean;
  estimationObservations: number;
  eventObservations: number;
} {
  const { returns, marketReturns } = params;
  if (returns.length !== marketReturns.length) {
    throw new Error("returns and marketReturns must be the same length");
  }
  const [estStart, estEnd] = params.estimationWindow;
  const [evStart, evEnd] = params.eventWindow;
  if (estEnd <= estStart) {
    throw new Error("estimation window must contain at least 2 observations");
  }
  if (estEnd > evStart) {
    throw new Error("estimation window must end before the event window starts");
  }
  // An empty or inverted event window leaves zero event days, and everything below still produces
  // a full result for it: a cumulative abnormal return of 0 with a p-value of 1, which reads as a
  // study that looked at an event and found nothing. The estimation window already refuses to be
  // too short; the event window has to refuse to be empty.
  if (evEnd <= evStart) {
    throw new Error("event window must contain at least 1 observation");
  }
  if (evEnd > returns.length || evStart < 0 || estStart < 0) {
    throw new Error("windows are out of range for the supplied series");
  }

  const estX = marketReturns.slice(estStart, estEnd);
  const estY = returns.slice(estStart, estEnd);
  const model = regressionDiagnostics(estX, estY);

  const abnormalReturns: number[] = [];
  for (let i = evStart; i < evEnd; i += 1) {
    abnormalReturns.push(returns[i] - (model.intercept + model.slope * marketReturns[i]));
  }
  const cumulativeAbnormalReturn = abnormalReturns.reduce((sum, value) => sum + value, 0);
  const eventDays = abnormalReturns.length;
  // Standard error of CAR scales with sqrt of the window length under iid abnormal returns.
  const standardError = model.residualStdError * Math.sqrt(eventDays);
  const tStatistic = standardError === 0 ? 0 : cumulativeAbnormalReturn / standardError;
  const pValue = studentTTwoTailedP(tStatistic, model.n - 2);

  return {
    alpha: model.intercept,
    beta: model.slope,
    abnormalReturns,
    cumulativeAbnormalReturn,
    tStatistic,
    pValue,
    significant: pValue <= 0.05,
    estimationObservations: estX.length,
    eventObservations: eventDays,
  };
}
