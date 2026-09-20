/**
 * Hedge-fund-grade quantitative finance primitives.
 *
 * Scope: portfolio construction, risk decomposition, performance attribution, and the statistical
 * corrections that decide whether a measured edge is real. These are the calculations a desk
 * refuses to let a model do in prose — a language model computing a risk contribution or an
 * attribution effect in its head will produce a number that looks right and is not.
 *
 * Every function is deterministic and takes explicit inputs. Nothing here infers a convention:
 * annualisation factors, sample vs population, and simple vs log returns are all parameters,
 * because a silent convention is how two correct numbers disagree.
 *
 * Numerical approach: covariance matrices are treated as symmetric positive definite and solved
 * through Cholesky rather than a general inverse. Cholesky both detects a non-positive-definite
 * matrix (which a general inverse would happily "solve" into nonsense) and is cheaper.
 */

// ---------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------

export type Matrix = number[][];

function assertSquare(matrix: Matrix, label = "matrix"): number {
  const n = matrix.length;
  if (n === 0) {
    throw new Error(`${label} must not be empty`);
  }
  for (const row of matrix) {
    if (row.length !== n) {
      throw new Error(`${label} must be square`);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Conditioning
// ---------------------------------------------------------------------------

export type Conditioning = {
  minEigenvalue: number;
  maxEigenvalue: number;
  conditionNumber: number;
  /**
   * True when the matrix is so close to singular that a solution built on it is an artefact of the
   * near-dependency rather than a portfolio. The threshold lives here, not in callers, so that
   * "ill-conditioned" means one thing across the toolkit.
   */
  illConditioned: boolean;
};

/**
 * The condition number beyond which an exact solve is arithmetically correct and economically
 * meaningless. Two tickers for the same asset sit at ~1e6; anything below that still carries real
 * idiosyncratic variance.
 */
const ILL_CONDITIONED = 1e6;

/** Power iteration. The matrix is symmetric positive definite, so every eigenvalue is positive and
 *  the dominant one in magnitude is the largest. */
function dominantEigenvalue(matrix: Matrix): number {
  const n = matrix.length;
  let vector = Array.from({ length: n }, () => 1);
  let eigenvalue = 0;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const product = Array.from({ length: n }, () => 0);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) {
        sum += matrix[i][j] * vector[j];
      }
      product[i] = sum;
    }
    let squared = 0;
    for (const value of product) {
      squared += value * value;
    }
    const norm = Math.sqrt(squared);
    if (!(norm > 0)) {
      return 0;
    }
    for (let i = 0; i < n; i += 1) {
      vector[i] = product[i] / norm;
    }
    let quotient = 0;
    for (let i = 0; i < n; i += 1) {
      quotient += vector[i] * product[i];
    }
    const converged = Math.abs(quotient - eigenvalue) <= 1e-12 * Math.abs(quotient);
    eigenvalue = quotient;
    if (converged) {
      break;
    }
  }
  return eigenvalue;
}

/**
 * How close a covariance matrix is to singular, and whether that is close enough to matter.
 *
 * A nearly collinear book — two tickers for the same asset, a token and its staked wrapper — is
 * still positive definite, so it solves cleanly and reports no error. What it returns is a set of
 * weights that exploits a dependency that exists only in the estimation noise: the optimiser finds
 * a near-arbitrage and leverages it sixteen or a hundred times over. The answer is arithmetically
 * right and useless, so the matrix says which it is.
 */
export function covarianceConditioning(matrix: Matrix): Conditioning {
  if (matrix.length === 0) {
    throw new Error("matrix required");
  }
  assertFiniteMatrixValues(matrix, "matrix");
  const n = matrix.length;
  if (matrix.some((row) => row.length !== n)) {
    throw new Error("matrix must be square");
  }
  const maxEigenvalue = dominantEigenvalue(matrix);
  // A singular matrix is the limiting case of an ill-conditioned one, not a different problem. It
  // has to be reported rather than raised: risk parity is well defined on it — equal contributions
  // do not need a unique solution — and turning that working call into a throw would be the bug.
  const factorisable = cholesky(matrix) !== null;
  if (!(maxEigenvalue > 0) || !factorisable) {
    return {
      minEigenvalue: 0,
      maxEigenvalue,
      conditionNumber: Infinity,
      illConditioned: true,
    };
  }
  // The smallest eigenvalue of Σ is the reciprocal of the largest eigenvalue of Σ⁻¹.
  const dominant = dominantEigenvalue(inverseSpd(matrix));
  const minEigenvalue = dominant > 0 ? 1 / dominant : 0;
  const conditionNumber = minEigenvalue > 0 ? maxEigenvalue / minEigenvalue : Infinity;
  return {
    minEigenvalue,
    maxEigenvalue,
    conditionNumber,
    illConditioned: conditionNumber > ILL_CONDITIONED,
  };
}

function assertFinite(values: number[], label: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite value`);
    }
  }
}

function assertFiniteMatrixValues(matrix: Matrix, label: string): void {
  for (const row of matrix) {
    assertFinite(row, label);
  }
}

export function matVec(matrix: Matrix, vector: number[]): number[] {
  const n = assertSquare(matrix);
  if (vector.length !== n) {
    throw new Error("matrix and vector dimensions disagree");
  }
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("vector lengths disagree");
  }
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

/**
 * Cholesky factorisation `A = L L'` for symmetric positive definite `A`.
 *
 * Returns `null` rather than throwing when `A` is not positive definite. A non-PD covariance is a
 * data problem (collinear assets, too few observations), and the caller has to be able to say so
 * instead of receiving a factorisation full of NaN.
 */
export function cholesky(matrix: Matrix): Matrix | null {
  const n = assertSquare(matrix);
  const lower: Matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let total = matrix[i][j];
      for (let k = 0; k < j; k += 1) {
        total -= lower[i][k] * lower[j][k];
      }
      if (i === j) {
        if (total <= 0 || !Number.isFinite(total)) {
          return null;
        }
        lower[i][j] = Math.sqrt(total);
      } else {
        lower[i][j] = total / lower[j][j];
      }
    }
  }
  return lower;
}

/** Solve `A x = b` via Cholesky. Throws with a usable reason when `A` is not positive definite. */
export function solveSpd(matrix: Matrix, b: number[]): number[] {
  const n = assertSquare(matrix);
  assertFinite(b, "b");
  if (b.length !== n) {
    throw new Error("matrix and vector dimensions disagree");
  }
  const lower = cholesky(matrix);
  if (!lower) {
    throw new Error("covariance matrix is not positive definite");
  }
  // Forward substitution L y = b
  const y = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n; i += 1) {
    let total = b[i];
    for (let k = 0; k < i; k += 1) {
      total -= lower[i][k] * y[k];
    }
    y[i] = total / lower[i][i];
  }
  // Back substitution L' x = y
  const x = Array.from({ length: n }, () => 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let total = y[i];
    for (let k = i + 1; k < n; k += 1) {
      total -= lower[k][i] * x[k];
    }
    x[i] = total / lower[i][i];
  }
  return x;
}

export function inverseSpd(matrix: Matrix): Matrix {
  const n = assertSquare(matrix);
  const columns: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const unit = Array.from({ length: n }, () => 0);
    unit[i] = 1;
    columns.push(solveSpd(matrix, unit));
  }
  // Columns of the inverse, transposed into rows.
  return Array.from({ length: n }, (_unused, row) => columns.map((column) => column[row]));
}

// ---------------------------------------------------------------------------
// Weight helpers
// ---------------------------------------------------------------------------

/** Project weights onto the simplex `sum(w) = 1` with optional per-asset bounds. */
export function normaliseWeights(weights: number[]): number[] {
  assertFinite(weights, "weights");
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    throw new Error("weights must not sum to zero");
  }
  return weights.map((value) => value / total);
}

/**
 * Clip weights into `[lower, upper]` and renormalise, iterating because a clip changes the sum.
 *
 * Used as the projection step for every constrained optimiser here. It is not a substitute for a
 * true constrained solver: with binding bounds it converges to a feasible point, not necessarily
 * the constrained optimum. Bounds that cannot be satisfied raise.
 */
export function clipAndRenormalise(
  weights: number[],
  bounds?: { lower?: number; upper?: number },
): number[] {
  const lower = bounds?.lower ?? 0;
  const upper = bounds?.upper ?? 1;
  if (lower * weights.length > 1 || upper * weights.length < 1) {
    throw new Error("weight bounds are infeasible: bounds cannot sum to 1");
  }
  let current = weights.map((value) => Math.min(upper, Math.max(lower, value)));
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const total = current.reduce((sum, value) => sum + value, 0);
    const gap = 1 - total;
    if (Math.abs(gap) < 1e-12) {
      break;
    }
    const slack = current.map((value) => (gap > 0 ? upper - value : value - lower));
    const slackTotal = slack.reduce((sum, value) => sum + value, 0);
    if (slackTotal <= 0) {
      break;
    }
    current = current.map((value, index) => value + (gap * slack[index]) / slackTotal);
    current = current.map((value) => Math.min(upper, Math.max(lower, value)));
  }
  return current;
}

// ---------------------------------------------------------------------------
// Portfolio construction
// ---------------------------------------------------------------------------

export type PortfolioSolution = {
  weights: number[];
  volatility: number;
  expectedReturn?: number;
  sharpe?: number;
  /** Per-asset risk contribution, summing to total volatility. */
  riskContributions: number[];
  /**
   * Sum of absolute weights. Equals 1 for a long-only fully invested book and exceeds it as soon as
   * the solution uses leverage or shorts. Reported because a tangency solution is allowed to be
   * short, and a weight of 2.09 read as "allocate 209%" is the expensive misunderstanding.
   */
  grossExposure: number;
  /** Sum of signed weights: the net market direction, which should be 1 for a normalised book. */
  netExposure: number;
  /**
   * Largest eigenvalue over smallest. Reported because a nearly collinear book still solves cleanly
   * and still reports no error, while the weights it returns are an artefact of a dependency that
   * only exists in the estimation noise. `grossExposure` says the answer is levered; this says the
   * leverage is spurious, and that `shrink_covariance` is the next call to make.
   */
  conditionNumber: number;
  /** True when `conditionNumber` is past the point where an exact solve means anything. */
  illConditioned: boolean;
  iterations?: number;
};

function portfolioRisk(w: number[], cov: Matrix): number {
  const variance = dot(w, matVec(cov, w));
  return Math.sqrt(Math.max(variance, 0));
}

function riskContributionsOf(weights: number[], cov: Matrix): number[] {
  const sigma = portfolioRisk(weights, cov);
  const marginal = matVec(cov, weights);
  if (sigma === 0) {
    return weights.map(() => 0);
  }
  return weights.map((weight, index) => (weight * marginal[index]) / sigma);
}

function summarise(
  weights: number[],
  cov: Matrix,
  expectedReturns?: number[],
  riskFreeRate = 0,
  iterations?: number,
): PortfolioSolution {
  const volatility = portfolioRisk(weights, cov);
  const riskContributions = riskContributionsOf(weights, cov);
  const conditioning = covarianceConditioning(cov);
  const base: PortfolioSolution = {
    weights,
    volatility,
    riskContributions,
    grossExposure: weights.reduce((sum, value) => sum + Math.abs(value), 0),
    netExposure: weights.reduce((sum, value) => sum + value, 0),
    conditionNumber: conditioning.conditionNumber,
    illConditioned: conditioning.illConditioned,
  };
  if (expectedReturns) {
    const expectedReturn = dot(weights, expectedReturns);
    base.expectedReturn = expectedReturn;
    base.sharpe = volatility === 0 ? undefined : (expectedReturn - riskFreeRate) / volatility;
  }
  return iterations === undefined ? base : { ...base, iterations };
}

/** Global minimum-variance portfolio. Closed form `w ∝ Σ⁻¹ 1`. */
export function minVariancePortfolio(
  cov: Matrix,
  bounds?: { lower?: number; upper?: number },
): PortfolioSolution {
  const n = assertSquare(cov, "covariance");
  const ones = Array.from({ length: n }, () => 1);
  const raw = solveSpd(cov, ones);
  const weights = bounds ? clipAndRenormalise(raw, bounds) : normaliseWeights(raw);
  return summarise(weights, cov);
}

/**
 * Maximum-Sharpe (tangency) portfolio, unconstrained: `w ∝ Σ⁻¹ (μ − r_f)`.
 *
 * Long-only is not enforced here: the tangency solution is genuinely allowed to be short, and
 * silently truncating it would report a portfolio that is not the one that was solved. Pass
 * `bounds` to get a projected long-only approximation and read `iterations`/`riskContributions`
 * to see what you actually got.
 */
export function maxSharpePortfolio(params: {
  expectedReturns: number[];
  cov: Matrix;
  riskFreeRate?: number;
  bounds?: { lower?: number; upper?: number };
}): PortfolioSolution {
  const n = assertSquare(params.cov, "covariance");
  if (params.expectedReturns.length !== n) {
    throw new Error("expectedReturns and covariance dimensions disagree");
  }
  const riskFreeRate = params.riskFreeRate ?? 0;
  const excess = params.expectedReturns.map((value) => value - riskFreeRate);
  const raw = solveSpd(params.cov, excess);
  if (!params.bounds) {
    // The closed form is w proportional to Σ^-1(mu - r), rescaled so the weights sum to one. When
    // the scale factor is negative there is no finite maximiser: enlarging the short side earns
    // without bound. Normalising regardless flips the sign of the whole vector, which hands back
    // the worst portfolio on the frontier under the name of the best one — observed as a negative
    // Sharpe from a "maximum Sharpe" call, at nine times gross exposure.
    const scale = raw.reduce((sum, value) => sum + value, 0);
    if (scale <= 0) {
      throw new Error(
        "the tangency portfolio is unbounded at these expected returns: there is no finite maximiser, so supply bounds or revise expectedReturns rather than reading a normalised sign flip as an answer",
      );
    }
  }
  const weights = params.bounds ? clipAndRenormalise(raw, params.bounds) : normaliseWeights(raw);
  return summarise(weights, params.cov, params.expectedReturns, riskFreeRate);
}

/**
 * Equal-risk-contribution (risk parity) portfolio.
 *
 * Solves Spinu's formulation: find `y > 0` with `y_i (Σ y)_i = 1` for all `i`, then `w = y / Σy`.
 * Newton with backtracking, because the naive fixed-point iteration diverges on correlated books.
 * At the solution every asset contributes exactly `1/n` of total risk — the test asserts this.
 */
export function riskParityPortfolio(
  cov: Matrix,
  options: { maxIterations?: number; tolerance?: number } = {},
): PortfolioSolution {
  const n = assertSquare(cov, "covariance");
  const maxIterations = options.maxIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-12;

  let y = Array.from({ length: n }, () => 1 / Math.sqrt(cov[0][0] || 1));
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    const sigmaY = matVec(cov, y);
    const gradient = y.map((value, index) => value * sigmaY[index] - 1);
    const norm = Math.max(...gradient.map(Math.abs));
    if (norm < tolerance) {
      break;
    }
    // Newton direction: solve (diag(sigmaY) + diag(y) Σ) d = -g
    const jacobian: Matrix = Array.from({ length: n }, (_unused, row) =>
      Array.from(
        { length: n },
        (_unusedColumn, column) => (row === column ? sigmaY[row] : 0) + y[row] * cov[row][column],
      ),
    );
    const step = solveSpd(
      // The Jacobian is not symmetric; symmetrise for Cholesky and accept the approximation.
      symmetrise(jacobian),
      gradient.map((value) => -value),
    );
    let stepSize = 1;
    let improved = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidate = y.map((value, index) => value + stepSize * step[index]);
      if (candidate.every((value) => value > 0)) {
        const candidateSigma = matVec(cov, candidate);
        const candidateNorm = Math.max(
          ...candidate.map((value, index) => Math.abs(value * candidateSigma[index] - 1)),
        );
        if (candidateNorm < norm) {
          y = candidate;
          improved = true;
          break;
        }
      }
      stepSize /= 2;
    }
    if (!improved) {
      break;
    }
  }

  const weights = normaliseWeights(y);
  return summarise(weights, cov, undefined, 0, iterations);
}

function symmetrise(matrix: Matrix): Matrix {
  const n = matrix.length;
  return Array.from({ length: n }, (_unused, row) =>
    Array.from(
      { length: n },
      (_unusedColumn, column) => 0.5 * (matrix[row][column] + matrix[column][row]),
    ),
  );
}

/**
 * Maximum-diversification portfolio: maximises `(w'σ) / sqrt(w'Σw)`.
 *
 * Closed form `w ∝ Σ⁻¹ σ` where `σ` is the vector of asset volatilities. Unlike risk parity it
 * tolerates zero correlation structure collapsing to the inverse-volatility portfolio.
 */
export function maxDiversificationPortfolio(cov: Matrix): PortfolioSolution {
  const n = assertSquare(cov, "covariance");
  const vols = Array.from({ length: n }, (_unused, index) =>
    Math.sqrt(Math.max(cov[index][index], 0)),
  );
  const raw = solveSpd(cov, vols);
  const weights = normaliseWeights(raw);
  const diversificationRatio = dot(weights, vols) / portfolioRisk(weights, cov);
  return {
    ...summarise(weights, cov),
    iterations: undefined,
    diversificationRatio,
  } as PortfolioSolution & { diversificationRatio: number };
}

/**
 * Black-Litterman posterior expected returns.
 *
 * `E[R] = [(τΣ)⁻¹ + P' Ω⁻¹ P]⁻¹ [(τΣ)⁻¹ Π + P' Ω⁻¹ Q]`
 *
 * Equilibrium returns `Π = δ Σ w_mkt` reverse-optimised from cap weights. Views are `(P, Q, Ω)`.
 * With no views the posterior must collapse back to `Π` — the test asserts that, because a
 * "combined" model that silently overrides the prior when views are absent is worse than no model.
 */
export function blackLitterman(params: {
  cov: Matrix;
  marketWeights: number[];
  riskAversion?: number;
  tau?: number;
  /** Pick matrix: one row per view, one column per asset. */
  P?: Matrix;
  /** View returns, one per row of `P`. */
  Q?: number[];
  /** Diagonal of the view uncertainty matrix `Ω`. Defaults to `τ · P Σ P'`. */
  omega?: number[];
}): { expectedReturns: number[]; equilibriumReturns: number[]; posteriorCovariance?: Matrix } {
  const n = assertSquare(params.cov, "covariance");
  assertFinite(params.marketWeights, "marketWeights");
  if (params.Q) {
    assertFinite(params.Q, "Q");
  }
  if (params.omega) {
    assertFinite(params.omega, "omega");
  }
  if (params.P) {
    assertFiniteMatrixValues(params.P, "P");
  }
  if (params.marketWeights.length !== n) {
    throw new Error("marketWeights and covariance dimensions disagree");
  }
  const delta = params.riskAversion ?? 2.5;
  const tau = params.tau ?? 0.025;

  const equilibrium = matVec(params.cov, params.marketWeights).map((value) => value * delta);
  const tauSigma = params.cov.map((row) => row.map((value) => value * tau));

  const P = params.P ?? [];
  const Q = params.Q ?? [];
  if (P.length === 0 || Q.length === 0) {
    return { expectedReturns: equilibrium, equilibriumReturns: equilibrium };
  }
  if (P.length !== Q.length) {
    throw new Error("each view needs a matching Q value");
  }
  for (const row of P) {
    if (row.length !== n) {
      throw new Error("each view row must have one entry per asset");
    }
  }

  const invTauSigma = inverseSpd(tauSigma);
  // Ω diagonal defaults to the variance of each view under the prior: τ · p' Σ p.
  const omega =
    params.omega ??
    P.map((row) => {
      const variance = dot(row, matVec(tauSigma, row));
      return variance > 0 ? variance : 1e-8;
    });
  if (omega.length !== P.length) {
    throw new Error("omega must have one entry per view");
  }

  // M = (τΣ)⁻¹ + P' Ω⁻¹ P
  const M = invTauSigma.map((row, rowIndex) =>
    row.map((value, columnIndex) => {
      let total = value;
      for (let view = 0; view < P.length; view += 1) {
        total += (P[view][rowIndex] * P[view][columnIndex]) / omega[view];
      }
      return total;
    }),
  );
  // b = (τΣ)⁻¹ Π + P' Ω⁻¹ Q
  const b = matVec(invTauSigma, equilibrium).map((value, rowIndex) => {
    let total = value;
    for (let view = 0; view < P.length; view += 1) {
      total += (P[view][rowIndex] * Q[view]) / omega[view];
    }
    return total;
  });

  const posterior = solveSpd(symmetrise(M), b);
  return {
    expectedReturns: posterior,
    equilibriumReturns: equilibrium,
    posteriorCovariance: inverseSpd(symmetrise(M)),
  };
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

function standardNormalQuantile(p: number): number {
  // Acklam's rational approximation: ~1.15e-9 absolute error, far better than A&S 7.1.26,
  // which matters once a quantile feeds a Cornish-Fisher expansion or an option pricer.
  if (p <= 0 || p >= 1) {
    throw new Error("probability must be strictly between 0 and 1");
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function moments(values: number[]): {
  mean: number;
  variance: number;
  stdDev: number;
  skewness: number;
  /** Excess kurtosis (0 for a normal distribution). */
  excessKurtosis: number;
} {
  const n = values.length;
  if (n < 4) {
    throw new Error("at least 4 observations required for moments");
  }
  assertFinite(values, "values");
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) {
    return { mean, variance, stdDev, skewness: 0, excessKurtosis: 0 };
  }
  let m3 = 0;
  let m4 = 0;
  for (const value of values) {
    const z = (value - mean) / stdDev;
    m3 += z ** 3;
    m4 += z ** 4;
  }
  // Sample-adjusted (Fisher) estimators.
  const skewness = (n / ((n - 1) * (n - 2))) * m3;
  const kurtosis =
    (n * (n + 1) * m4) / ((n - 1) * (n - 2) * (n - 3)) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return { mean, variance, stdDev, skewness, excessKurtosis: kurtosis };
}

/**
 * Cornish-Fisher value at risk.
 *
 * Extends the Gaussian quantile with skewness and excess kurtosis, which is the difference between
 * a VaR number and a VaR number that survives a fat-tailed book. Reported alongside the Gaussian
 * VaR so the size of the correction is visible rather than baked in.
 */
export function cornishFisherVar(params: { returns: number[]; confidenceLevel?: number }): {
  varGaussian: number;
  varCornishFisher: number;
  correction: number;
  skewness: number;
  excessKurtosis: number;
  volatility: number;
} {
  const confidence = params.confidenceLevel ?? 0.95;
  const stats = moments(params.returns);
  const tailProbability = 1 - confidence;
  const z = standardNormalQuantile(tailProbability);
  const { skewness: s, excessKurtosis: k } = stats;
  const zCf =
    z + ((z ** 2 - 1) * s) / 6 + ((z ** 3 - 3 * z) * k) / 24 - ((2 * z ** 3 - 5 * z) * s ** 2) / 36;
  // The expansion is a cubic in the moments, so once the higher-order terms dominate, the adjusted
  // quantile crosses to the other side of the distribution and the "VaR" comes out negative —
  // observed at skew -11.6 with excess kurtosis 151, where it reported -0.017, i.e. no risk at all.
  // Refusing is the only honest output: any number produced past this point is not a VaR.
  if (Math.sign(zCf) !== Math.sign(z) || Math.abs(zCf - z) > Math.abs(z)) {
    throw new Error(
      `the Cornish-Fisher expansion is not valid at this skewness (${s.toFixed(2)}) and excess kurtosis (${k.toFixed(2)}): the adjusted quantile leaves the tail it started in, so use the Gaussian VaR, a historical quantile, or a fitted tail instead`,
    );
  }
  const varGaussian = -(stats.mean + z * stats.stdDev);
  const varCornishFisher = -(stats.mean + zCf * stats.stdDev);
  return {
    varGaussian,
    varCornishFisher,
    correction: varCornishFisher - varGaussian,
    skewness: s,
    excessKurtosis: k,
    volatility: stats.stdDev,
  };
}

/**
 * Parametric component VaR.
 *
 * Marginal VaR is `∂VaR/∂w_i = z (Σw)_i / σ_p`, and component VaR `w_i · MVaR_i` sums exactly to
 * portfolio VaR (Euler decomposition). That additivity is asserted in the tests — a decomposition
 * that does not add up cannot be used to attribute risk.
 */
export function componentVar(params: {
  weights: number[];
  cov: Matrix;
  confidenceLevel?: number;
}): {
  portfolioVolatility: number;
  portfolioVar: number;
  marginalVar: number[];
  componentVar: number[];
  componentShare: number[];
} {
  const confidence = params.confidenceLevel ?? 0.95;
  // A NaN weight otherwise flows straight into componentVar and out again: the decomposition still
  // "adds up" because NaN plus NaN is NaN, so the identity that guards this function does not catch it.
  assertFinite(params.weights, "weights");
  assertFiniteMatrixValues(params.cov, "cov");
  const z = standardNormalQuantile(1 - confidence);
  const sigmaP = portfolioRisk(params.weights, params.cov);
  const marginalSigma = matVec(params.cov, params.weights);
  if (sigmaP === 0) {
    return {
      portfolioVolatility: 0,
      portfolioVar: 0,
      marginalVar: params.weights.map(() => 0),
      componentVar: params.weights.map(() => 0),
      componentShare: params.weights.map(() => 0),
    };
  }
  // Loss is expressed as a positive number: VaR = -z σ with z negative for the left tail.
  const portfolioVar = -z * sigmaP;
  const marginalVar = marginalSigma.map((value) => (-z * value) / sigmaP);
  const componentVar = params.weights.map((weight, index) => weight * marginalVar[index]);
  const total = componentVar.reduce((sum, value) => sum + value, 0);
  return {
    portfolioVolatility: sigmaP,
    portfolioVar,
    marginalVar,
    componentVar,
    componentShare: componentVar.map((value) => (total === 0 ? 0 : value / total)),
  };
}

/**
 * RiskMetrics EWMA covariance.
 *
 * `Σ_t = λ Σ_{t-1} + (1 − λ) r_{t-1} r'_{t-1}`. λ = 0.94 is the daily RiskMetrics convention.
 */
export function ewmaCovariance(params: { returnsMatrix: Matrix; lambda?: number }): {
  covariance: Matrix;
  lambda: number;
  observations: number;
} {
  const lambda = params.lambda ?? 0.94;
  // lambda is the weight on the previous estimate, so 1 - lambda is the weight on the newest
  // observation. Above 1 that weight goes negative and the bias correction (1 - lambda^n) changes
  // sign: the recursion still returns a plausible matrix, built on weights that grow with age.
  if (!(lambda > 0 && lambda <= 1)) {
    throw new Error(`lambda must be in (0, 1], received ${lambda}`);
  }
  const rows = params.returnsMatrix;
  if (rows.length === 0) {
    throw new Error("returnsMatrix required");
  }
  assertFiniteMatrixValues(rows, "returnsMatrix");
  const n = rows[0].length;
  if (lambda === 1) {
    // No decay means every observation counts equally, which is the equal-weighted second moment.
    // The recursion cannot express it — (1 - lambda) is zero, so nothing accumulates — so the
    // degenerate case is handled directly rather than returning a matrix of zeros.
    const equalWeighted: Matrix = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => 0),
    );
    for (const row of rows) {
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          equalWeighted[i][j] += (row[i] * row[j]) / rows.length;
        }
      }
    }
    return { covariance: symmetrise(equalWeighted), lambda, observations: rows.length };
  }
  // Start from zero rather than from a constant diagonal. Seeding with a fixed variance meant that
  // on a short or very quiet history the answer was mostly the seed: five observations of a
  // stablecoin and five of a large-cap produced nearly the same number, because both were still
  // reporting the initialiser. Zero plus the bias correction below makes the estimate data-driven.
  const covariance: Matrix = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (const row of rows) {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        covariance[i][j] = lambda * covariance[i][j] + (1 - lambda) * row[i] * row[j];
      }
    }
  }
  // The recursion's weights sum to (1 - lambda^obs), not to 1, so an uncorrected EWMA understates
  // variance badly on short histories. Dividing restores the scale.
  const observations = rows.length;
  const normaliser = 1 - Math.pow(lambda, observations);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      covariance[i][j] /= normaliser;
    }
  }
  return { covariance: symmetrise(covariance), lambda, observations };
}

/** Scenario P&L: applies each shock vector to the book. */
export function stressTest(params: {
  weights: number[];
  scenarios: Array<{ name: string; shocks: number[] }>;
}): Array<{ name: string; pnl: number }> {
  assertFinite(params.weights, "weights");
  for (const scenario of params.scenarios) {
    assertFinite(scenario.shocks, `scenario "${scenario.name}" shocks`);
  }
  return params.scenarios.map((scenario) => ({
    name: scenario.name,
    pnl: dot(params.weights, scenario.shocks),
  }));
}

// ---------------------------------------------------------------------------
// Performance attribution and inference
// ---------------------------------------------------------------------------

/**
 * Brinson-Fachler attribution.
 *
 * Allocation:  Σ (w_p,i − w_b,i)(R_b,i − R_b)
 * Selection:   Σ w_b,i (R_p,i − R_b,i)
 * Interaction: Σ (w_p,i − w_b,i)(R_p,i − R_b,i)
 *
 * The three effects plus the benchmark return must reconstruct the portfolio return exactly; the
 * test asserts that identity, because attribution that does not close has an arithmetic bug.
 */
export function brinsonAttribution(params: {
  sectors: string[];
  portfolioWeights: number[];
  portfolioReturns: number[];
  benchmarkWeights: number[];
  benchmarkReturns: number[];
}): {
  portfolioReturn: number;
  benchmarkReturn: number;
  activeReturn: number;
  allocation: number;
  selection: number;
  interaction: number;
  bySector: Array<{
    sector: string;
    allocation: number;
    selection: number;
    interaction: number;
  }>;
} {
  const count = params.sectors.length;
  for (const [label, array] of [
    ["portfolioWeights", params.portfolioWeights],
    ["portfolioReturns", params.portfolioReturns],
    ["benchmarkWeights", params.benchmarkWeights],
    ["benchmarkReturns", params.benchmarkReturns],
  ] as const) {
    assertFinite(array, label);
    if (array.length !== count) {
      throw new Error(`${label} must have one entry per sector`);
    }
  }
  const benchmarkReturn = dot(params.benchmarkWeights, params.benchmarkReturns);
  const portfolioReturn = dot(params.portfolioWeights, params.portfolioReturns);

  let allocation = 0;
  let selection = 0;
  let interaction = 0;
  const bySector: Array<{
    sector: string;
    allocation: number;
    selection: number;
    interaction: number;
  }> = [];

  for (let i = 0; i < count; i += 1) {
    const weightGap = params.portfolioWeights[i] - params.benchmarkWeights[i];
    const returnGap = params.portfolioReturns[i] - params.benchmarkReturns[i];
    const sectorAllocation = weightGap * (params.benchmarkReturns[i] - benchmarkReturn);
    const sectorSelection = params.benchmarkWeights[i] * returnGap;
    const sectorInteraction = weightGap * returnGap;
    allocation += sectorAllocation;
    selection += sectorSelection;
    interaction += sectorInteraction;
    bySector.push({
      sector: params.sectors[i],
      allocation: sectorAllocation,
      selection: sectorSelection,
      interaction: sectorInteraction,
    });
  }

  return {
    portfolioReturn,
    benchmarkReturn,
    activeReturn: portfolioReturn - benchmarkReturn,
    allocation,
    selection,
    interaction,
    bySector,
  };
}

/**
 * Newey-West HAC estimate of the standard error of the mean.
 *
 * `Var(x̄) = (γ_0 + 2 Σ_{j=1..L} (1 − j/(L+1)) γ_j) / n`
 *
 * Autocorrelation and heteroskedasticity both inflate the naive standard error; a Sharpe ratio
 * reported with `σ/sqrt(n)` on autocorrelated daily returns is systematically too flattering.
 */
export function neweyWestMean(params: { values: number[]; lags?: number }): {
  mean: number;
  standardError: number;
  tStatistic: number;
  lags: number;
  naiveStandardError: number;
} {
  const values = params.values;
  const n = values.length;
  if (n < 2) {
    throw new Error("at least 2 observations required");
  }
  assertFinite(values, "values");
  const lags = params.lags ?? Math.floor(Math.pow(n, 1 / 3));
  // Past n - 1 there are no autocovariances left to weight, so a larger bandwidth does not buy
  // more correction: it reweights noise and, with the clamp below, can shrink the standard error
  // towards zero, which inflates the t statistic. grangerCausality already refuses the same shape.
  if (lags < 0 || lags >= n) {
    throw new Error(`lags must be between 0 and ${n - 1} for ${n} observations`);
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const deviations = values.map((value) => value - mean);

  let gamma0 = deviations.reduce((sum, value) => sum + value * value, 0) / n;
  let adjusted = gamma0;
  for (let lag = 1; lag <= lags; lag += 1) {
    let gammaLag = 0;
    for (let i = lag; i < n; i += 1) {
      gammaLag += deviations[i] * deviations[i - lag];
    }
    gammaLag /= n;
    adjusted += 2 * (1 - lag / (lags + 1)) * gammaLag;
  }
  // Guard against a negative variance estimate from aggressive lag truncation.
  const variance = Math.max(adjusted, 0) / n;
  const standardError = Math.sqrt(variance);
  const naiveStandardError = Math.sqrt(gamma0 / n);
  return {
    mean,
    standardError,
    tStatistic: standardError === 0 ? 0 : mean / standardError,
    lags,
    naiveStandardError,
  };
}

/** Jarque-Bera normality test on the sample. */
export function jarqueBera(values: number[]): {
  statistic: number;
  skewness: number;
  excessKurtosis: number;
  /** True at the 5% level (critical value 5.99, 2 dof). */
  rejectNormalityAt5Pct: boolean;
} {
  const stats = moments(values);
  const statistic = (values.length / 6) * (stats.skewness ** 2 + stats.excessKurtosis ** 2 / 4);
  return {
    statistic,
    skewness: stats.skewness,
    excessKurtosis: stats.excessKurtosis,
    rejectNormalityAt5Pct: statistic > 5.991,
  };
}

/**
 * Autocorrelation function: the "echo" of a series against itself at each lag.
 *
 * This is deliberately a report, not a verdict. Durbin-Watson only speaks about
 * lag 1 and Newey-West consumes autocorrelations without showing them, so
 * neither answers "at which lags does this series remember itself?" — which is
 * what decides whether momentum or mean-reversion has anything to stand on.
 *
 * `significanceBand` is the white-noise band (≈1.96/√n). A lag whose |r| exceeds
 * it is flagged, but the caller decides what that means: this function does not
 * claim a series is trending, mean-reverting, or tradable.
 */
export function autocorrelationFunction(params: { values: number[]; maxLag?: number }): {
  n: number;
  maxLag: number;
  /** Autocorrelation at lag 1..maxLag (index 0 is lag 1). */
  lags: number[];
  significanceBand: number;
  significant: boolean[];
} {
  // Reject rather than drop: dropping a missing candle silently re-pairs the observations on
  // either side of it, so a lag-1 correlation starts measuring a lag-2 relationship instead.
  assertFinite(params.values, "values");
  const values = params.values.slice();
  const n = values.length;
  if (n < 8) {
    throw new Error("at least 8 finite observations required for an ACF");
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const deviations = values.map((value) => value - mean);
  const gamma0 = deviations.reduce((sum, value) => sum + value * value, 0);
  if (gamma0 === 0) {
    throw new Error("a constant series has no autocorrelation to report");
  }
  const maxLag = Math.max(
    1,
    Math.min(params.maxLag ?? Math.floor(n / 2) - 1, Math.floor(n / 2) - 1),
  );
  const lags: number[] = [];
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = lag; i < n; i += 1) {
      sum += deviations[i] * deviations[i - lag];
    }
    lags.push(sum / gamma0);
  }
  const significanceBand = 1.96 / Math.sqrt(n);
  return {
    n,
    maxLag,
    lags,
    significanceBand,
    significant: lags.map((value) => Math.abs(value) > significanceBand),
  };
}

/**
 * Partial autocorrelation: the echo at lag k with the shorter lags removed.
 *
 * Durbin-Levinson recursion on the ACF above. ACF at lag 3 is contaminated by
 * the lag 1 and 2 paths; PACF isolates the direct lag-3 contribution, which is
 * what an AR(p) order selection actually looks at.
 */
export function partialAutocorrelationFunction(params: { values: number[]; maxLag?: number }): {
  n: number;
  maxLag: number;
  /** Partial autocorrelation at lag 1..maxLag (index 0 is lag 1). */
  lags: number[];
  significanceBand: number;
  significant: boolean[];
} {
  const acf = autocorrelationFunction(params);
  const rho = acf.lags;
  const maxLag = rho.length;
  // phi[k][j] is the j-th coefficient of the AR(k) fit; phi[k][k] is the PACF at lag k+1.
  const phi: number[][] = [];
  const pacf: number[] = [];
  for (let k = 0; k < maxLag; k += 1) {
    const previous = k === 0 ? [] : phi[k - 1];
    let numerator = rho[k];
    let denominator = 1;
    for (let j = 0; j < k; j += 1) {
      numerator -= previous[j] * rho[k - j - 1];
      denominator -= previous[j] * rho[j];
    }
    const current = denominator === 0 ? 0 : numerator / denominator;
    const row: number[] = Array.from({ length: k + 1 }, () => 0);
    for (let j = 0; j < k; j += 1) {
      row[j] = previous[j] - current * previous[k - j - 1];
    }
    row[k] = current;
    phi.push(row);
    pacf.push(current);
  }
  return {
    n: acf.n,
    maxLag,
    lags: pacf,
    significanceBand: acf.significanceBand,
    significant: pacf.map((value) => Math.abs(value) > acf.significanceBand),
  };
}

/** Durbin-Watson statistic; ~2 means no first-order autocorrelation. */
export function durbinWatson(residuals: number[]): number {
  assertFinite(residuals, "residuals");
  if (residuals.length < 2) {
    throw new Error("at least 2 residuals required");
  }
  let numerator = 0;
  let denominator = 0;
  for (let i = 1; i < residuals.length; i += 1) {
    numerator += (residuals[i] - residuals[i - 1]) ** 2;
  }
  for (const value of residuals) {
    denominator += value ** 2;
  }
  return denominator === 0 ? 2 : numerator / denominator;
}

// ---------------------------------------------------------------------------
// Trading costs
// ---------------------------------------------------------------------------

export function turnoverAndCost(params: {
  currentWeights: number[];
  targetWeights: number[];
  costBasisPoints?: number;
}): { turnover: number; trades: number[]; cost: number } {
  assertFinite(params.currentWeights, "currentWeights");
  assertFinite(params.targetWeights, "targetWeights");
  if (params.currentWeights.length !== params.targetWeights.length) {
    throw new Error("weight vectors must match in length");
  }
  const trades = params.targetWeights.map((weight, index) => weight - params.currentWeights[index]);
  const turnover = trades.reduce((sum, value) => sum + Math.abs(value), 0) / 2;
  const costBp = params.costBasisPoints ?? 5;
  return { turnover, trades, cost: (turnover * 2 * costBp) / 10_000 };
}
