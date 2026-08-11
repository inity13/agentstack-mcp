// DecisionMatrix engine — deterministic multi-criteria decision analysis (MCDA).
//
// Every number flows through decimal.js (fixed precision) so results are exact,
// reproducible, and independent of platform float behaviour. The engine is pure
// and stateless: identical inputs always produce byte-identical output.
//
// Supported methods:
//   - weighted_sum     (Simple Additive Weighting / SAW) — min-max normalization
//   - weighted_product (Weighted Product Model / WPM)     — ratio normalization
//   - topsis           (closeness to the ideal solution)  — vector normalization
//
// All tools return the same agent-friendly envelope described in the README.
import Decimal from "decimal.js";

// 40 significant digits is far more than any decision needs; it guarantees that
// normalization / division / sqrt round deterministically the same way everywhere.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const D = (x) => new Decimal(String(x));

const ENGINE_VERSION = "1.0.0-edge";

// ---------------------------------------------------------------------------
// Errors — never cross the tool boundary as raw exceptions.
// ---------------------------------------------------------------------------
export class DecisionError extends Error {
  constructor(message, { hint = null, type = "invalid_input" } = {}) {
    super(message);
    this.hint = hint;
    this.type = type;
  }
}
export function errEnvelope(message, type = "invalid_input", hint = null) {
  return { status: "error", error: { type, message, hint } };
}

// ---------------------------------------------------------------------------
// Numeric helpers.
// ---------------------------------------------------------------------------
function toDec(name, value) {
  if (value === undefined || value === null || value === "")
    throw new DecisionError(`'${name}' is required and must be a number.`, {
      hint: `Provide a numeric value for '${name}'.`, type: "missing_parameter",
    });
  if (typeof value === "boolean")
    throw new DecisionError(`'${name}' must be a number, got a boolean.`, { hint: "Use a numeric score, e.g. 8 or 0.5." });
  try {
    const d = new Decimal(String(value));
    if (d.isNaN() || !d.isFinite()) throw new Error("nan");
    return d;
  } catch {
    throw new DecisionError(`'${name}' is not a valid number: ${JSON.stringify(value)}.`, {
      hint: "Pass a finite numeric value, e.g. 7, 250, or 0.9.",
    });
  }
}
// Full-precision plain string with trailing zeros trimmed (stable JSON).
function exact(d) {
  let s = d.toFixed();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
// Human/agent friendly rounded number (deterministic HALF_UP at 6 dp).
function round6(d) {
  return Number(d.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toString());
}
function pct(d) {
  let s = d.times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();
  return `${s}%`;
}

// ---------------------------------------------------------------------------
// Direction normalization ("benefit" = higher is better, "cost" = lower).
// ---------------------------------------------------------------------------
const BENEFIT = "benefit";
const COST = "cost";
const DIRECTION_ALIASES = {
  benefit: BENEFIT, max: BENEFIT, maximize: BENEFIT, higher: BENEFIT,
  higher_is_better: BENEFIT, up: BENEFIT, positive: BENEFIT, "+": BENEFIT,
  cost: COST, min: COST, minimize: COST, lower: COST,
  lower_is_better: COST, down: COST, negative: COST, "-": COST,
};
function normalizeDirection(raw, critName) {
  if (raw === undefined || raw === null || raw === "") return BENEFIT;
  const key = String(raw).trim().toLowerCase();
  const dir = DIRECTION_ALIASES[key];
  if (!dir)
    throw new DecisionError(`Criterion '${critName}' has an unknown direction '${raw}'.`, {
      hint: "Use 'benefit' (higher is better) or 'cost' (lower is better).",
      type: "invalid_direction",
    });
  return dir;
}

// ---------------------------------------------------------------------------
// Input parsing / validation.
// ---------------------------------------------------------------------------
function parseOptions(options) {
  if (!Array.isArray(options) || options.length === 0)
    throw new DecisionError("'options' must be a non-empty array of alternatives.", {
      hint: 'Example: ["Vendor A", "Vendor B"] or [{"name":"Vendor A"}].',
      type: "missing_parameter",
    });
  const names = [];
  const inlineScores = new Map(); // name -> {crit: value}
  const seen = new Set();
  options.forEach((o, i) => {
    let name;
    if (typeof o === "string") name = o;
    else if (o && typeof o === "object" && typeof o.name === "string") {
      name = o.name;
      if (o.scores && typeof o.scores === "object") inlineScores.set(name, o.scores);
    } else {
      throw new DecisionError(`options[${i}] must be a string name or an object with a 'name'.`, {
        hint: 'Example: "Vendor A" or {"name":"Vendor A","scores":{"Cost":100}}.',
      });
    }
    name = name.trim();
    if (!name) throw new DecisionError(`options[${i}] has an empty name.`, { hint: "Give every option a non-empty name." });
    if (seen.has(name))
      throw new DecisionError(`Duplicate option name '${name}'.`, {
        hint: "Option names must be unique so results can be referenced unambiguously.",
        type: "duplicate_option",
      });
    seen.add(name);
    names.push(name);
  });
  return { names, inlineScores };
}

function parseCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0)
    throw new DecisionError("'criteria' must be a non-empty array of {name, weight, direction?}.", {
      hint: 'Example: [{"name":"Price","weight":2,"direction":"cost"},{"name":"Quality","weight":3}].',
      type: "missing_parameter",
    });
  const out = [];
  const seen = new Set();
  criteria.forEach((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c))
      throw new DecisionError(`criteria[${i}] must be an object {name, weight, direction?}.`, {
        hint: 'Example: {"name":"Price","weight":2,"direction":"cost"}.',
      });
    const name = String(c.name ?? "").trim();
    if (!name) throw new DecisionError(`criteria[${i}] is missing a 'name'.`, { hint: "Give every criterion a non-empty name." });
    if (seen.has(name))
      throw new DecisionError(`Duplicate criterion name '${name}'.`, {
        hint: "Criterion names must be unique.", type: "duplicate_criterion",
      });
    seen.add(name);
    const weight = toDec(`criteria['${name}'].weight`, c.weight);
    if (weight.lt(0))
      throw new DecisionError(`Criterion '${name}' has a negative weight (${exact(weight)}).`, {
        hint: "Weights must be zero or positive. Relative size is what matters (e.g. 1,2,3).",
        type: "invalid_weight",
      });
    out.push({ name, weight, direction: normalizeDirection(c.direction, name) });
  });
  const total = out.reduce((a, c) => a.plus(c.weight), D(0));
  if (total.lte(0))
    throw new DecisionError("At least one criterion must have a weight greater than 0.", {
      hint: "Give your most important criteria larger weights.", type: "invalid_weight",
    });
  // Normalized weights (sum to 1) for scoring + transparency.
  for (const c of out) c.weightNorm = c.weight.div(total);
  return { criteria: out, weightTotal: total };
}

// Build a dense options x criteria matrix from any accepted score shape.
function buildMatrix(optionNames, inlineScores, criteria, scores) {
  const map = new Map(); // optName -> Map(critName -> Decimal)
  for (const n of optionNames) map.set(n, new Map());

  const ingest = (optName, critScores, where, skipUnknown = false) => {
    if (!map.has(optName)) {
      // The object-map score form is a lookup table: extra options that are not
      // part of this decision (e.g. when compare_two is handed the full matrix)
      // are simply ignored. Explicit array/inline forms stay strict.
      if (skipUnknown) return;
      throw new DecisionError(`${where} refers to unknown option '${optName}'.`, {
        hint: `Known options: ${optionNames.join(", ")}.`, type: "unknown_option",
      });
    }
    if (!critScores || typeof critScores !== "object")
      throw new DecisionError(`${where} for option '${optName}' must be an object of {criterion: number}.`, {
        hint: 'Example: {"Price": 100, "Quality": 8}.',
      });
    const bucket = map.get(optName);
    for (const [crit, val] of Object.entries(critScores)) bucket.set(crit, toDec(`scores['${optName}']['${crit}']`, val));
  };

  // 1) inline scores on option objects.
  for (const [optName, cs] of inlineScores.entries()) ingest(optName, cs, "options[].scores");

  // 2) the dedicated `scores` argument (object map OR array of {option, scores}).
  if (scores !== undefined && scores !== null) {
    if (Array.isArray(scores)) {
      scores.forEach((row, i) => {
        if (!row || typeof row !== "object")
          throw new DecisionError(`scores[${i}] must be {option|name, scores:{...}}.`, {
            hint: 'Example: {"option":"Vendor A","scores":{"Price":100}}.',
          });
        const optName = String(row.option ?? row.name ?? "").trim();
        ingest(optName, row.scores, `scores[${i}]`);
      });
    } else if (typeof scores === "object") {
      for (const [optName, cs] of Object.entries(scores)) ingest(String(optName).trim(), cs, "scores", true);
    } else {
      throw new DecisionError("'scores' must be an object map {option:{criterion:value}} or an array of {option, scores}.", {
        hint: 'Object form: {"Vendor A":{"Price":100,"Quality":8}}.',
        type: "invalid_scores",
      });
    }
  }

  // Completeness check with a precise, actionable error.
  const missing = [];
  const raw = optionNames.map((opt) => {
    const bucket = map.get(opt);
    return criteria.map((c) => {
      if (!bucket.has(c.name)) missing.push(`${opt} / ${c.name}`);
      return bucket.get(c.name);
    });
  });
  if (missing.length) {
    const preview = missing.slice(0, 8).join("; ");
    throw new DecisionError(
      `Missing ${missing.length} score(s) in the options x criteria matrix.`,
      {
        hint: `Provide a score for every option and criterion. Missing: ${preview}${missing.length > 8 ? "; ..." : ""}.`,
        type: "incomplete_scores",
      },
    );
  }
  return raw; // raw[i][j] Decimal
}

// ---------------------------------------------------------------------------
// Column stats + normalizations (per criterion j).
// ---------------------------------------------------------------------------
function columnStats(raw, j) {
  let min = raw[0][j], max = raw[0][j];
  for (let i = 1; i < raw.length; i++) {
    if (raw[i][j].lt(min)) min = raw[i][j];
    if (raw[i][j].gt(max)) max = raw[i][j];
  }
  return { min, max };
}

// Min-max -> [0,1] with 1 = best after direction is applied. Used by weighted_sum.
function normMinMax(x, min, max, direction) {
  const range = max.minus(min);
  if (range.isZero()) return { r: D(1), degenerate: true }; // all equal -> neutral (tie)
  const r = direction === COST ? max.minus(x).div(range) : x.minus(min).div(range);
  return { r, degenerate: false };
}

// ---------------------------------------------------------------------------
// Method implementations. Each returns { scores:Decimal[], normalized:Decimal[][],
// contributions:Decimal[][], meta:{...}, notes:[] }.
// normalized[i][j] is the per-criterion normalized score (0..1, best=1 where possible).
// contributions[i][j] is that criterion's contribution to option i's final score.
// ---------------------------------------------------------------------------
function methodWeightedSum(raw, criteria) {
  const n = raw.length, m = criteria.length;
  const normalized = raw.map(() => new Array(m));
  const contributions = raw.map(() => new Array(m));
  const scores = new Array(n).fill(null).map(() => D(0));
  const notes = [];
  const degenerate = [];
  for (let j = 0; j < m; j++) {
    const { min, max } = columnStats(raw, j);
    for (let i = 0; i < n; i++) {
      const { r, degenerate: deg } = normMinMax(raw[i][j], min, max, criteria[j].direction);
      if (deg && i === 0) degenerate.push(criteria[j].name);
      normalized[i][j] = r;
      const contrib = criteria[j].weightNorm.times(r);
      contributions[i][j] = contrib;
      scores[i] = scores[i].plus(contrib);
    }
  }
  if (degenerate.length)
    notes.push(`Criteria with identical scores across all options were treated as neutral (normalized to 1): ${degenerate.join(", ")}.`);
  return { scores, normalized, contributions, notes, higherIsBetter: true };
}

function methodWeightedProduct(raw, criteria) {
  const n = raw.length, m = criteria.length;
  const normalized = raw.map(() => new Array(m));
  const contributions = raw.map(() => new Array(m));
  const scores = new Array(n).fill(null).map(() => D(1));
  const notes = ["Weighted Product multiplies each option's normalized scores raised to their weight; it rewards balanced options and punishes any weak criterion."];
  for (let j = 0; j < m; j++) {
    const { min, max } = columnStats(raw, j);
    // Ratio normalization requires strictly positive raw scores.
    for (let i = 0; i < n; i++) {
      if (raw[i][j].lte(0))
        throw new DecisionError(
          `weighted_product requires all scores to be greater than 0 (option '${i}', criterion '${criteria[j].name}' is ${exact(raw[i][j])}).`,
          { hint: "Shift your scores to a positive range (e.g. use 1-10 instead of 0-9) or use method 'weighted_sum'/'topsis'.", type: "invalid_scores" },
        );
    }
    for (let i = 0; i < n; i++) {
      // benefit: x/max in (0,1]; cost: min/x in (0,1].
      const r = criteria[j].direction === COST ? min.div(raw[i][j]) : raw[i][j].div(max);
      normalized[i][j] = r;
      const factor = r.pow(criteria[j].weightNorm); // r^w
      contributions[i][j] = factor;
      scores[i] = scores[i].times(factor);
    }
  }
  return { scores, normalized, contributions, notes, higherIsBetter: true };
}

function methodTopsis(raw, criteria) {
  const n = raw.length, m = criteria.length;
  const normalized = raw.map(() => new Array(m)); // vector-normalized r
  const weighted = raw.map(() => new Array(m)); // v = w*r
  const notes = ["TOPSIS ranks options by closeness to the ideal solution and distance from the anti-ideal; the score is a 0-1 closeness coefficient."];
  // Vector normalization denominator per column.
  for (let j = 0; j < m; j++) {
    let sumsq = D(0);
    for (let i = 0; i < n; i++) sumsq = sumsq.plus(raw[i][j].times(raw[i][j]));
    const denom = sumsq.sqrt();
    for (let i = 0; i < n; i++) {
      const r = denom.isZero() ? D(0) : raw[i][j].div(denom);
      normalized[i][j] = r;
      weighted[i][j] = criteria[j].weightNorm.times(r);
    }
  }
  // Ideal best / worst per criterion (direction aware).
  const best = new Array(m), worst = new Array(m);
  for (let j = 0; j < m; j++) {
    let colMin = weighted[0][j], colMax = weighted[0][j];
    for (let i = 1; i < n; i++) {
      if (weighted[i][j].lt(colMin)) colMin = weighted[i][j];
      if (weighted[i][j].gt(colMax)) colMax = weighted[i][j];
    }
    if (criteria[j].direction === COST) { best[j] = colMin; worst[j] = colMax; }
    else { best[j] = colMax; worst[j] = colMin; }
  }
  const scores = new Array(n);
  const contributions = raw.map(() => new Array(m));
  for (let i = 0; i < n; i++) {
    let dPlus = D(0), dMinus = D(0);
    for (let j = 0; j < m; j++) {
      const toBest = weighted[i][j].minus(best[j]);
      const toWorst = weighted[i][j].minus(worst[j]);
      dPlus = dPlus.plus(toBest.times(toBest));
      dMinus = dMinus.plus(toWorst.times(toWorst));
      // Per-criterion contribution shown as the weighted value v (not additive to C).
      contributions[i][j] = weighted[i][j];
    }
    dPlus = dPlus.sqrt();
    dMinus = dMinus.sqrt();
    const denom = dPlus.plus(dMinus);
    scores[i] = denom.isZero() ? D(0) : dMinus.div(denom);
  }
  notes.push("For TOPSIS, 'weighted_contribution' is the weighted normalized value v[i][j]; the final closeness score is not a simple sum of these.");
  return { scores, normalized, contributions, notes, higherIsBetter: true };
}

const METHODS = {
  weighted_sum: methodWeightedSum,
  weighted_product: methodWeightedProduct,
  topsis: methodTopsis,
};

export const METHOD_CATALOG = {
  weighted_sum: {
    name: "Weighted Sum Model (Simple Additive Weighting)",
    aliases: ["saw", "weighted_average", "additive"],
    description: "Normalizes each criterion to 0-1 (min-max, direction-aware), multiplies by the criterion weight, and sums. The most transparent and widely used MCDA method.",
    normalization: "min-max per criterion (best value -> 1, worst -> 0)",
    score_range: "0 to 1 (higher is better)",
    best_for: "Most everyday decisions; fully explainable, additive breakdowns.",
    handles_negative_scores: true,
  },
  weighted_product: {
    name: "Weighted Product Model",
    aliases: ["wpm", "geometric", "multiplicative"],
    description: "Normalizes by ratio to the best value and multiplies each option's normalized scores raised to their weight. Penalizes options that are weak on any single criterion (no full compensation).",
    normalization: "ratio per criterion (benefit x/max, cost min/x)",
    score_range: "0 to 1 (higher is better)",
    best_for: "When a serious weakness on one criterion should not be offset by strengths elsewhere.",
    handles_negative_scores: false,
  },
  topsis: {
    name: "TOPSIS (Technique for Order Preference by Similarity to Ideal Solution)",
    aliases: ["ideal", "ideal_solution"],
    description: "Vector-normalizes and weights the matrix, then ranks options by their closeness to the ideal solution and distance from the anti-ideal solution.",
    normalization: "vector (Euclidean) per criterion",
    score_range: "0 to 1 closeness coefficient (higher is better)",
    best_for: "Comparing trade-offs against a best/worst benchmark; robust with many criteria.",
    handles_negative_scores: true,
  },
};

function resolveMethod(method) {
  const key = String(method || "weighted_sum").trim().toLowerCase();
  if (METHODS[key]) return key;
  // alias resolution
  for (const [canon, spec] of Object.entries(METHOD_CATALOG))
    if (spec.aliases.includes(key)) return canon;
  throw new DecisionError(`Unknown method '${method}'.`, {
    hint: `Supported methods: ${Object.keys(METHODS).join(", ")}. Call list_methods for details.`,
    type: "unknown_method",
  });
}

// ---------------------------------------------------------------------------
// Core analysis shared by create_decision / score_options / compare_two.
// ---------------------------------------------------------------------------
function rankAll(optionNames, criteria, raw, methodKey) {
  const result = METHODS[methodKey](raw, criteria);
  const rows = optionNames.map((name, i) => ({
    name,
    index: i,
    scoreDec: result.scores[i],
    normalized: result.normalized[i],
    contributions: result.contributions[i],
  }));
  // Deterministic ordering: score desc, then original input order (index asc).
  rows.sort((a, b) => {
    const c = b.scoreDec.cmp(a.scoreDec);
    return c !== 0 ? c : a.index - b.index;
  });
  // Assign ranks with tie awareness (equal scores share a rank).
  let prev = null, rank = 0;
  rows.forEach((r, i) => {
    if (prev === null || !r.scoreDec.eq(prev)) rank = i + 1;
    r.rank = rank;
    prev = r.scoreDec;
  });
  return { rows, notes: result.notes };
}

function buildBreakdown(row, criteria) {
  return criteria.map((c, j) => ({
    criterion: c.name,
    direction: c.direction,
    weight: round6(c.weightNorm),
    weight_raw: exact(c.weight),
    raw_score: exact(rawOf(row, j)),
    normalized_score: round6(row.normalized[j]),
    weighted_contribution: round6(row.contributions[j]),
  }));
}
// helper to reach the raw score used for this row (kept alongside contributions)
function rawOf(row, j) { return row._raw[j]; }

function rankingEntries(rows, criteria) {
  return rows.map((r) => ({
    rank: r.rank,
    option: r.name,
    score: round6(r.scoreDec),
    score_exact: exact(r.scoreDec),
    breakdown: buildBreakdown(r, criteria),
  }));
}

// Natural-language explanation of the outcome.
function explain(rows, criteria, methodKey) {
  const winner = rows[0];
  const spec = METHOD_CATALOG[methodKey];
  const tiedTop = rows.filter((r) => r.rank === 1);
  // Top contributing criteria for the winner.
  const contribs = criteria
    .map((c, j) => ({ name: c.name, v: winner.contributions[j] }))
    .sort((a, b) => b.v.cmp(a.v));
  const drivers = contribs.slice(0, Math.min(2, contribs.length)).map((c) => c.name);

  if (tiedTop.length > 1) {
    const names = tiedTop.map((r) => `'${r.name}'`).join(" and ");
    return `Using the ${spec.name}, ${names} tie for first place with a score of ${round6(winner.scoreDec)}. ` +
      `The result is a genuine tie under the current weights — adjust the criteria weights or add a tie-breaking criterion to separate them.`;
  }

  const runnerUp = rows[1];
  let s = `Using the ${spec.name}, '${winner.name}' ranks #1 with a score of ${round6(winner.scoreDec)}`;
  if (runnerUp) {
    const margin = winner.scoreDec.minus(runnerUp.scoreDec);
    const marginPct = runnerUp.scoreDec.isZero() ? null : margin.div(runnerUp.scoreDec);
    s += `, ahead of '${runnerUp.name}' (${round6(runnerUp.scoreDec)})`;
    if (marginPct) s += ` by ${pct(marginPct)}`;
    s += ".";
  } else {
    s += ".";
  }
  if (drivers.length) s += ` Its ranking is driven mainly by ${drivers.join(" and ")}.`;
  s += ` Scores are 0-1 and normalized within this specific set of options, so they measure relative standing, not absolute quality.`;
  return s;
}

// Attach the raw scores onto rows so buildBreakdown can read them.
function attachRaw(rows, raw) {
  for (const r of rows) r._raw = raw[r.index];
  return rows;
}

function methodologyBlock(methodKey, criteria) {
  const spec = METHOD_CATALOG[methodKey];
  return {
    method: methodKey,
    name: spec.name,
    description: spec.description,
    normalization: spec.normalization,
    score_range: spec.score_range,
    weighting: "Criteria weights are normalized to sum to 1; only their relative sizes matter.",
    tie_breaking: "Equal scores share a rank; presentation order falls back to input order.",
    deterministic: true,
  };
}

function weightsUsed(criteria) {
  return criteria.map((c) => ({
    criterion: c.name,
    direction: c.direction,
    weight_input: exact(c.weight),
    weight_normalized: round6(c.weightNorm),
  }));
}

// ===========================================================================
// TOOL: create_decision
// ===========================================================================
function create_decision_impl(args = {}) {
  const { options, criteria, scores, method } = args;
  const { names, inlineScores } = parseOptions(options);
  if (names.length < 2)
    throw new DecisionError("Provide at least 2 options to rank.", {
      hint: "Add more alternatives, or use compare_two for a head-to-head between exactly two.",
      type: "too_few_options",
    });
  const { criteria: crit } = parseCriteria(criteria);
  const methodKey = resolveMethod(method);
  const raw = buildMatrix(names, inlineScores, crit, scores);

  const { rows, notes } = rankAll(names, crit, raw, methodKey);
  attachRaw(rows, raw);
  const ranking = rankingEntries(rows, crit);
  const winnerRow = rows[0];
  const tied = rows.filter((r) => r.rank === 1).map((r) => r.name);

  const outNotes = [
    "Scores are normalized within this option set; they express relative standing, not an absolute grade.",
    "Weights were normalized to sum to 1 (relative importance).",
    ...notes,
  ];
  if (tied.length > 1) outNotes.unshift(`Top-rank tie between: ${tied.join(", ")}.`);

  return {
    status: "success",
    method: methodKey,
    winner: {
      option: winnerRow.name,
      score: round6(winnerRow.scoreDec),
      score_exact: exact(winnerRow.scoreDec),
      rank: 1,
      tie: tied.length > 1,
      tied_with: tied.length > 1 ? tied.filter((n) => n !== winnerRow.name) : [],
    },
    ranking,
    methodology: methodologyBlock(methodKey, crit),
    weights_used: weightsUsed(crit),
    inputs_used: {
      options: names,
      criteria: crit.map((c) => ({ name: c.name, weight: exact(c.weight), direction: c.direction })),
      method: methodKey,
      option_count: names.length,
      criterion_count: crit.length,
    },
    notes: outNotes,
    explanation: explain(rows, crit, methodKey),
  };
}

// ===========================================================================
// TOOL: score_options — scoring pass when scores are supplied separately.
// Same math, leaner output focused on the scored matrix.
// ===========================================================================
function score_options_impl(args = {}) {
  const { options, criteria, scores, method } = args;
  const { names, inlineScores } = parseOptions(options);
  const { criteria: crit } = parseCriteria(criteria);
  const methodKey = resolveMethod(method);
  if ((scores === undefined || scores === null) && inlineScores.size === 0)
    throw new DecisionError("score_options requires a 'scores' matrix.", {
      hint: 'Provide scores as {"Vendor A":{"Price":100,"Quality":8}} or inline on each option.',
      type: "missing_parameter",
    });
  const raw = buildMatrix(names, inlineScores, crit, scores);
  const { rows, notes } = rankAll(names, crit, raw, methodKey);
  attachRaw(rows, raw);

  const scored = rows.map((r) => ({
    option: r.name,
    rank: r.rank,
    total_score: round6(r.scoreDec),
    total_score_exact: exact(r.scoreDec),
    criteria: buildBreakdown(r, crit),
  }));

  return {
    status: "success",
    method: methodKey,
    scored,
    ranking: rows.map((r) => ({ rank: r.rank, option: r.name, score: round6(r.scoreDec) })),
    methodology: methodologyBlock(methodKey, crit),
    weights_used: weightsUsed(crit),
    inputs_used: { options: names, method: methodKey, option_count: names.length, criterion_count: crit.length },
    notes: [
      "score_options returns the full scored matrix; use create_decision for a winner + narrative explanation.",
      ...notes,
    ],
    explanation: `Scored ${names.length} option(s) across ${crit.length} criterion/criteria using the ${METHOD_CATALOG[methodKey].name}. Highest total score: '${rows[0].name}' (${round6(rows[0].scoreDec)}).`,
  };
}

// ===========================================================================
// TOOL: compare_two — head-to-head between exactly two options.
// ===========================================================================
function compare_two_impl(args = {}) {
  const { criteria, scores, method } = args;
  // Accept either explicit option_a/option_b names, or a 2-element options array.
  let a = args.option_a, b = args.option_b;
  let optionObjs = args.options;
  const { criteria: crit } = parseCriteria(criteria);
  const methodKey = resolveMethod(method);

  let names, inlineScores;
  if (Array.isArray(optionObjs) && optionObjs.length) {
    ({ names, inlineScores } = parseOptions(optionObjs));
  } else {
    if (!a || !b)
      throw new DecisionError("compare_two needs two options via 'option_a' and 'option_b' (or a 2-element 'options' array).", {
        hint: 'Example: {"option_a":"Vendor A","option_b":"Vendor B", ...}.',
        type: "missing_parameter",
      });
    ({ names, inlineScores } = parseOptions([a, b]));
  }
  if (names.length !== 2)
    throw new DecisionError(`compare_two requires exactly 2 options (got ${names.length}).`, {
      hint: "Use create_decision to rank 3 or more options.", type: "wrong_option_count",
    });

  const raw = buildMatrix(names, inlineScores, crit, scores);
  const { rows, notes } = rankAll(names, crit, raw, methodKey);
  attachRaw(rows, raw);

  const [top, other] = rows;
  const tie = top.scoreDec.eq(other.scoreDec);

  // Per-criterion head-to-head: who wins each criterion (on normalized score).
  const byIndex = {};
  for (const r of rows) byIndex[r.name] = r;
  const perCriterion = crit.map((c, j) => {
    const na = byIndex[names[0]].normalized[j];
    const nb = byIndex[names[1]].normalized[j];
    let favours = "tie";
    if (na.gt(nb)) favours = names[0];
    else if (nb.gt(na)) favours = names[1];
    return {
      criterion: c.name,
      direction: c.direction,
      weight: round6(c.weightNorm),
      [`${names[0]}_raw`]: exact(byIndex[names[0]]._raw[j]),
      [`${names[1]}_raw`]: exact(byIndex[names[1]]._raw[j]),
      [`${names[0]}_normalized`]: round6(na),
      [`${names[1]}_normalized`]: round6(nb),
      favours,
    };
  });
  const wins = { [names[0]]: 0, [names[1]]: 0 };
  for (const pc of perCriterion) if (pc.favours !== "tie") wins[pc.favours]++;

  const margin = top.scoreDec.minus(other.scoreDec);
  const marginPct = other.scoreDec.isZero() ? null : margin.div(other.scoreDec);
  const explanation = tie
    ? `'${names[0]}' and '${names[1]}' are tied at ${round6(top.scoreDec)} under the ${METHOD_CATALOG[methodKey].name}. Adjust weights or add a criterion to break the tie.`
    : `'${top.name}' beats '${other.name}' ${round6(top.scoreDec)} to ${round6(other.scoreDec)}` +
      (marginPct ? ` (a ${pct(marginPct)} margin)` : "") +
      `. '${top.name}' wins ${wins[top.name]} of ${crit.length} criteria head-to-head.`;

  return {
    status: "success",
    method: methodKey,
    winner: tie ? null : top.name,
    tie,
    margin: round6(margin),
    scores: { [names[0]]: round6(byIndex[names[0]].scoreDec), [names[1]]: round6(byIndex[names[1]].scoreDec) },
    criteria_wins: wins,
    per_criterion: perCriterion,
    breakdown: rankingEntries(rows, crit),
    methodology: methodologyBlock(methodKey, crit),
    weights_used: weightsUsed(crit),
    inputs_used: { options: names, method: methodKey },
    notes: [
      "'favours' compares the two options' normalized scores on each criterion.",
      ...notes,
    ],
    explanation,
  };
}

// ===========================================================================
// TOOL: sensitivity_analysis — how robust is the winner to weight changes?
// ===========================================================================
function sensitivity_analysis_impl(args = {}) {
  const { options, criteria, scores, method } = args;
  const variation = args.variation === undefined || args.variation === null ? 0.2 : Number(toDec("variation", args.variation).toString());
  const steps = args.steps === undefined || args.steps === null ? 10 : parseInt(String(args.steps), 10);
  if (!(variation > 0) || variation > 1)
    throw new DecisionError(`'variation' must be between 0 (exclusive) and 1 (got ${args.variation}).`, {
      hint: "0.2 means each criterion weight is swept +/-20%.", type: "invalid_input",
    });
  if (!(steps >= 2) || steps > 100)
    throw new DecisionError(`'steps' must be an integer between 2 and 100 (got ${args.steps}).`, {
      hint: "10 steps across the range is a good default.", type: "invalid_input",
    });

  const { names, inlineScores } = parseOptions(options);
  if (names.length < 2) throw new DecisionError("Provide at least 2 options for sensitivity analysis.", { hint: "Add more alternatives.", type: "too_few_options" });
  const { criteria: crit } = parseCriteria(criteria);
  const methodKey = resolveMethod(method);
  const raw = buildMatrix(names, inlineScores, crit, scores);

  // Baseline.
  const base = rankAll(names, crit, raw, methodKey);
  const baseWinner = base.rows[0].name;
  const baseWinnerTied = base.rows.filter((r) => r.rank === 1).length > 1;

  // Sweep each criterion's weight over [w*(1-variation), w*(1+variation)],
  // renormalizing the remaining weights proportionally at each step.
  const perCriterion = crit.map((c, jTarget) => {
    const lo = c.weight.times(D(1).minus(D(variation)));
    const hi = c.weight.times(D(1).plus(D(variation)));
    const stepSize = hi.minus(lo).div(steps - 1);
    let winnerChanges = 0;
    let flipWeight = null;
    const scenarioWinners = [];
    for (let s = 0; s < steps; s++) {
      const wj = lo.plus(stepSize.times(s));
      const perturbed = crit.map((cc, j) => ({ ...cc, weight: j === jTarget ? wj : cc.weight }));
      // renormalize
      const total = perturbed.reduce((acc, cc) => acc.plus(cc.weight), D(0));
      for (const cc of perturbed) cc.weightNorm = total.lte(0) ? D(0) : cc.weight.div(total);
      const r = rankAll(names, perturbed, raw, methodKey);
      const w = r.rows[0].name;
      scenarioWinners.push({ weight: round6(wj), weight_normalized: round6(perturbed[jTarget].weightNorm), winner: w });
      if (w !== baseWinner) {
        winnerChanges++;
        if (flipWeight === null) flipWeight = round6(wj);
      }
    }
    return {
      criterion: c.name,
      baseline_weight: exact(c.weight),
      tested_range: { from: round6(lo), to: round6(hi) },
      winner_stable: winnerChanges === 0,
      scenarios_flipped: winnerChanges,
      scenarios_total: steps,
      first_flip_at_weight: flipWeight,
      scenario_winners: scenarioWinners,
    };
  });

  const totalScenarios = perCriterion.reduce((a, c) => a + c.scenarios_total, 0);
  const flipped = perCriterion.reduce((a, c) => a + c.scenarios_flipped, 0);
  const robustness = totalScenarios ? round6(D(totalScenarios - flipped).div(totalScenarios)) : 1;
  const fragileCriteria = perCriterion.filter((c) => !c.winner_stable).map((c) => c.criterion);

  let explanation;
  if (baseWinnerTied) {
    explanation = `The baseline result is a tie for first, so sensitivity is measured against '${baseWinner}'. `;
  } else {
    explanation = `Baseline winner is '${baseWinner}'. `;
  }
  if (flipped === 0) {
    explanation += `The winner is fully robust: it stays #1 across all ${totalScenarios} weight-perturbation scenarios (each criterion swept +/-${Math.round(variation * 100)}%).`;
  } else {
    explanation += `The winner changes in ${flipped} of ${totalScenarios} scenarios (robustness ${(robustness * 100).toFixed(1)}%). ` +
      `Most sensitive to the weight of: ${fragileCriteria.join(", ")}.`;
  }

  return {
    status: "success",
    method: methodKey,
    baseline_winner: baseWinner,
    baseline_winner_tie: baseWinnerTied,
    variation,
    steps,
    robustness_score: robustness,
    robustness_pct: `${(robustness * 100).toFixed(1)}%`,
    fragile_criteria: fragileCriteria,
    per_criterion: perCriterion,
    methodology: {
      ...methodologyBlock(methodKey, crit),
      procedure: `For each criterion, its weight is swept from -${Math.round(variation * 100)}% to +${Math.round(variation * 100)}% of its baseline in ${steps} steps; the other weights are renormalized and the winner is recomputed at each step.`,
    },
    weights_used: weightsUsed(crit),
    inputs_used: { options: names, method: methodKey, option_count: names.length, criterion_count: crit.length },
    notes: [
      "Robustness = share of scenarios in which the baseline winner remains #1.",
      "Only one criterion's weight is varied at a time (one-at-a-time sensitivity).",
    ],
    explanation,
  };
}

// ===========================================================================
// TOOL: list_methods
// ===========================================================================
function list_methods_impl() {
  return {
    status: "success",
    count: Object.keys(METHOD_CATALOG).length,
    default_method: "weighted_sum",
    methods: METHOD_CATALOG,
    directions: {
      benefit: "Higher raw scores are better (quality, speed, features). Aliases: max, maximize, higher_is_better.",
      cost: "Lower raw scores are better (price, latency, risk). Aliases: min, minimize, lower_is_better.",
    },
    notes: [
      "Weights are relative; they are normalized to sum to 1 internally.",
      "All methods are 100% deterministic and computed with 40-digit decimal precision.",
    ],
  };
}

// ===========================================================================
// TOOL: health_check
// ===========================================================================
function health_check_impl() {
  return {
    status: "ok",
    server: "DecisionMatrix",
    version: ENGINE_VERSION,
    precision: "decimal.js (40 significant digits)",
    deterministic: true,
    stateless: true,
    tools: ["create_decision", "score_options", "sensitivity_analysis", "compare_two", "list_methods", "health_check"],
    methods: Object.keys(METHOD_CATALOG),
    runtime: "cloudflare-pages-functions",
  };
}

// ---------------------------------------------------------------------------
// Public tool entrypoints. Every tool is guarded so a validation problem comes
// back as a structured { status:"error", error:{type,message,hint} } envelope
// instead of a thrown exception — the same contract whether the engine is used
// standalone (imports/tests) or behind the MCP transport.
// ---------------------------------------------------------------------------
function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch (e) {
      if (e instanceof DecisionError) return errEnvelope(e.message, e.type, e.hint);
      return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema.");
    }
  };
}

export const create_decision = guard(create_decision_impl);
export const score_options = guard(score_options_impl);
export const compare_two = guard(compare_two_impl);
export const sensitivity_analysis = guard(sensitivity_analysis_impl);
export const list_methods = guard(list_methods_impl);
export const health_check = guard(health_check_impl);
