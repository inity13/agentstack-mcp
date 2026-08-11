// AgentStack composite tools — the cross-domain reasoning that no single server
// can do alone. Each composite chains the three vendored engines:
//
//   simulate (ScenarioSim) -> decide (DecisionMatrix) -> compute (PrecisionCalc)
//
// Everything stays 100% deterministic: the composites only orchestrate pure,
// stateless engine calls and reshape their structured output. Identical inputs
// always produce identical output.
import * as SS from "./engines/scenariosim.mjs";
import * as DM from "./engines/decisionmatrix.mjs";
import * as PC from "./engines/precisioncalc.mjs";

// ---------------------------------------------------------------------------
// Shared error envelope (matches every product's contract).
// ---------------------------------------------------------------------------
export class StackError extends Error {
  constructor(message, { hint = null, type = "invalid_input" } = {}) {
    super(message);
    this.hint = hint;
    this.type = type;
  }
}
export function errEnvelope(message, type = "invalid_input", hint = null) {
  return { status: "error", error: { type, message, hint } };
}

// PrecisionCalc engine functions THROW CalcError (they are not self-guarded like
// the other two). Wrap any PC call so a bad input becomes a structured envelope.
function pc(fn, args) {
  try { return fn(args); }
  catch (e) { return errEnvelope(e.message, e.type || "calc_error", e.hint || null); }
}

// Pull the sub-scenario assumptions (accept inputs|assumptions|top-level spread).
function scenarioArgs(base, option) {
  return {
    template: option.template ?? base.template,
    period_label: option.period_label ?? base.period_label,
    horizon: option.horizon ?? base.horizon,
    inputs: { ...(base.inputs || {}), ...(option.inputs || {}) },
    metrics: option.metrics ?? base.metrics,
  };
}

// ===========================================================================
// COMPOSITE 1 — plan_to_valuation  (ScenarioSim -> PrecisionCalc)
// Project a scenario, take a per-period cashflow line from its projections, and
// value it (NPV + IRR + payback) with exact decimal finance math.
// ===========================================================================
export function plan_to_valuation(args = {}) {
  const cashflowMetric = String(args.cashflow_metric ?? "");
  if (!cashflowMetric)
    return errEnvelope("plan_to_valuation needs 'cashflow_metric' (a per-period projection field to treat as cash flow).", "missing_parameter",
      'e.g. "mrr" for saas_growth, "net_burn" for cash_runway, "value" for compound_growth. Run sim_run first to see available fields.');
  if (args.rate === undefined || args.rate === null || args.rate === "")
    return errEnvelope("plan_to_valuation needs a discount 'rate' (per period, decimal).", "missing_parameter", "e.g. 0.01 for 1%/period.");

  const sim = SS.run_scenario({ template: args.template, inputs: args.inputs, metrics: args.metrics, horizon: args.horizon, period_label: args.period_label });
  if (sim.status === "error") return { ...sim, stage: "simulate" };

  const rows = sim.projections.filter((r) => r.period >= 1);
  if (!rows.length) return errEnvelope("The scenario produced no projected periods.", "empty_projection", "Increase 'horizon'.");
  const sample = rows[0];
  if (!(cashflowMetric in sample) || typeof sample[cashflowMetric] !== "number") {
    const numeric = Object.keys(sample).filter((k) => k !== "period" && typeof sample[k] === "number");
    return errEnvelope(`'${cashflowMetric}' is not a numeric projection field for scenario '${sim.scenario}'.`, "unknown_metric", `Available per-period fields: ${numeric.join(", ")}.`);
  }

  const invest = args.initial_investment === undefined || args.initial_investment === null ? 0 : Number(args.initial_investment);
  const series = rows.map((r) => r[cashflowMetric]);
  // Period 0 = the up-front investment as a negative outflow (0 if none).
  const cashflows = [-Math.abs(invest), ...series];
  const currency = args.currency || "USD";

  const npv = pc(PC.net_present_value, { rate: args.rate, cashflows, currency });
  if (npv.status === "error") return { ...npv, stage: "valuation" };

  // IRR only exists when there's at least one sign change (needs an outflow).
  let irr = null, irrNote = null;
  const hasNeg = cashflows.some((c) => c < 0), hasPos = cashflows.some((c) => c > 0);
  if (hasNeg && hasPos) {
    const r = pc(PC.internal_rate_of_return, { cashflows });
    if (r.status === "error") irrNote = `IRR unavailable: ${r.error.message}`;
    else irr = { value: round6(Number(r.value)), formatted: r.formatted_value };
  } else {
    irrNote = invest > 0
      ? "IRR skipped: cashflows do not change sign."
      : "IRR skipped: provide 'initial_investment' (a period-0 outflow) to compute IRR.";
  }

  const npvNum = round6(Number(npv.value));
  return {
    status: "success",
    composite: "plan_to_valuation",
    pipeline: ["scenariosim.run_scenario", "precisioncalc.net_present_value", "precisioncalc.internal_rate_of_return"],
    scenario: { template: sim.scenario, horizon: sim.horizon, period_label: sim.period_label, key_results: sim.key_results },
    cashflow_metric: cashflowMetric,
    initial_investment: Math.abs(invest),
    cashflows,
    valuation: {
      discount_rate: Number(String(args.rate)),
      currency,
      npv: npvNum,
      npv_formatted: npv.formatted_value,
      value_creating: npvNum > 0,
      irr: irr ? irr.value : null,
      irr_formatted: irr ? irr.formatted : null,
      total_undiscounted_cashflow: series.reduce((a, b) => a + b, 0) - Math.abs(invest),
    },
    assumptions_used: sim.assumptions_used,
    methodology: {
      pipeline: "The scenario's per-period '" + cashflowMetric + "' line is used as the cash-flow stream; period 0 is the initial investment (outflow). NPV discounts it at the per-period rate; IRR solves NPV=0.",
      precision: "decimal.js (40 significant digits) end-to-end",
      deterministic: true,
    },
    notes: [
      "Cash flow = the chosen projection field per period; sign conventions follow that field (e.g. 'net_burn' is positive when burning).",
      irrNote,
      "Discount 'rate' is per period; annualize separately if periods are not years.",
    ].filter(Boolean),
    explanation:
      `Projecting '${sim.scenario}' over ${sim.horizon} ${sim.period_label}(s) and valuing the '${cashflowMetric}' stream at ${(Number(String(args.rate)) * 100)}%/period gives an NPV of ${npv.formatted_value}` +
      (irr ? ` and an IRR of ${irr.formatted}` : "") +
      `. ${npvNum > 0 ? "The plan is value-creating at this discount rate." : "The plan does not create value at this discount rate."}`,
  };
}

// ===========================================================================
// COMPOSITE 2 — evaluate_options_with_scenarios  (ScenarioSim -> DecisionMatrix)
// Project each option as its own scenario, then rank the options against
// weighted criteria drawn from the scenario OUTCOMES.
// ===========================================================================
export function evaluate_options_with_scenarios(args = {}) {
  const options = args.options;
  if (!Array.isArray(options) || options.length < 2)
    return errEnvelope("evaluate_options_with_scenarios needs an 'options' array of 2+ scenario variants.", "missing_parameter",
      'Example: {"template":"saas_growth","options":[{"name":"Aggressive","inputs":{"new_customers_per_period":60}},{"name":"Lean","inputs":{"new_customers_per_period":20}}],"criteria":[{"metric":"ending_mrr","weight":3},{"metric":"cumulative_revenue","weight":1}]}');
  const criteria = args.criteria;
  if (!Array.isArray(criteria) || !criteria.length)
    return errEnvelope("Provide 'criteria': an array of {metric, weight, direction?} where metric is a scenario key_result.", "missing_parameter",
      'Example: [{"metric":"ending_mrr","weight":3,"direction":"benefit"},{"metric":"total_churned_customers","weight":1,"direction":"cost"}].');

  // 1) Run each option as a scenario.
  const runs = [];
  const names = [];
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt || typeof opt !== "object") return errEnvelope(`options[${i}] must be an object {name?, inputs}.`, "invalid_input");
    const name = String(opt.name ?? `Option ${i + 1}`);
    const sim = SS.run_scenario(scenarioArgs(args, opt));
    if (sim.status === "error") return { ...sim, stage: "simulate", failed_option: name };
    if (names.includes(name)) return errEnvelope(`Duplicate option name '${name}'.`, "duplicate_option", "Give each option a unique name.");
    names.push(name);
    runs.push({ name, sim });
  }

  // 2) Build the score matrix from scenario key_results.
  const dmCriteria = criteria.map((c, i) => {
    const metric = String(c.metric ?? c.name ?? "");
    if (!metric) throw_missing(i);
    if (c.weight === undefined || c.weight === null) return { name: metric, weight: 1, direction: c.direction || "benefit" };
    return { name: metric, weight: c.weight, direction: c.direction || "benefit" };
  });
  const scores = {};
  for (const { name, sim } of runs) {
    const row = {};
    for (const c of dmCriteria) {
      const v = sim.key_results[c.name];
      if (v === undefined || v === null)
        return errEnvelope(`Criterion metric '${c.name}' is not a key_result of scenario '${sim.scenario}' (option '${name}').`, "unknown_metric",
          `Available key_results: ${Object.keys(sim.key_results).join(", ")}.`);
      row[c.name] = v;
    }
    scores[name] = row;
  }

  // 3) Rank with DecisionMatrix.
  const decision = DM.create_decision({ options: names, criteria: dmCriteria, scores, method: args.method });
  if (decision.status === "error") return { ...decision, stage: "decide" };

  return {
    status: "success",
    composite: "evaluate_options_with_scenarios",
    pipeline: ["scenariosim.run_scenario (per option)", "decisionmatrix.create_decision"],
    winner: decision.winner,
    ranking: decision.ranking,
    method: decision.method,
    options_evaluated: runs.map((r) => ({ name: r.name, template: r.sim.scenario, key_results: r.sim.key_results, assumptions_used: r.sim.assumptions_used })),
    score_matrix: scores,
    weights_used: decision.weights_used,
    methodology: {
      pipeline: "Each option is projected forward as an independent scenario; the chosen key_results become the criteria scores; DecisionMatrix ranks the options against the weighted criteria (direction-aware).",
      decision_methodology: decision.methodology,
      precision: "decimal.js (40 significant digits) end-to-end",
      deterministic: true,
    },
    notes: [
      "Criteria 'metric' names must be key_results of the scenario (see options_evaluated[].key_results).",
      "direction: 'benefit' (higher is better, default) or 'cost' (lower is better).",
      ...(decision.notes || []),
    ],
    explanation:
      `Projected ${runs.length} option(s) and ranked them on ${dmCriteria.map((c) => c.name).join(", ")}. ` +
      (decision.winner?.tie ? `Result is a tie for first.` : `Best option: '${decision.winner.option}' (score ${decision.winner.score}).`),
  };
}
function throw_missing(i) { throw new StackError(`criteria[${i}] needs a 'metric' name.`, { hint: "e.g. {\"metric\":\"ending_mrr\",\"weight\":3}." }); }

// ===========================================================================
// COMPOSITE 3 — stress_test_decision  (ScenarioSim sensitivity x DecisionMatrix)
// Take an options-vs-scenarios decision and stress one scenario assumption
// across a range applied to EVERY option; report how often the winner survives.
// ===========================================================================
export function stress_test_decision(args = {}) {
  const stress = args.stress || {};
  const variable = String(stress.variable ?? "");
  if (!variable)
    return errEnvelope("stress_test_decision needs 'stress.variable' (a scenario input to perturb across all options).", "missing_parameter",
      'Example: {"stress":{"variable":"churn_rate","variation":0.5,"steps":5}, ...evaluate_options_with_scenarios args...}.');
  const variation = stress.variation === undefined || stress.variation === null ? 0.2 : Number(stress.variation);
  if (!(variation > 0) || variation > 1) return errEnvelope(`'stress.variation' must be in (0,1] (got ${stress.variation}).`, "invalid_input", "0.5 sweeps +/-50% around each option's baseline.");
  const steps = clampInt(stress.steps, 5, 2, 50);

  // Baseline decision.
  const base = evaluate_options_with_scenarios(args);
  if (base.status === "error") return { ...base, stage: "baseline" };
  const baseWinner = base.winner?.option;

  // Each option's baseline value for the stressed variable (from resolved assumptions_used).
  const optionBaseVals = {};
  for (const o of base.options_evaluated) {
    const v = o.assumptions_used?.[variable];
    if (v === undefined) return errEnvelope(`Stress variable '${variable}' is not an input of the scenario template.`, "unknown_input", `Valid inputs appear in options_evaluated[].assumptions_used.`);
    optionBaseVals[o.name] = Number(v);
  }

  // Sweep a shared multiplier in [1-variation, 1+variation]; scale each option's
  // own baseline value by it (preserves the differences between options).
  const lo = 1 - variation, hi = 1 + variation;
  const stepSize = (hi - lo) / (steps - 1);
  const perStep = [];
  let flips = 0, firstFlipAt = null;
  for (let s = 0; s < steps; s++) {
    const factor = lo + stepSize * s;
    const stressedOptions = (args.options || []).map((opt, i) => {
      const name = String(opt.name ?? `Option ${i + 1}`);
      const scaled = optionBaseVals[name] * factor;
      return { ...opt, inputs: { ...(opt.inputs || {}), [variable]: scaled } };
    });
    const evalR = evaluate_options_with_scenarios({ ...args, options: stressedOptions });
    if (evalR.status === "error") return { ...evalR, stage: "stress", factor };
    const w = evalR.winner?.option;
    perStep.push({ factor: round4(factor), multiplier_pct: `${round2((factor - 1) * 100)}%`, winner: w, winner_score: evalR.winner?.score });
    if (w !== baseWinner) { flips++; if (firstFlipAt === null) firstFlipAt = round4(factor); }
  }
  const robustness = (steps - flips) / steps;

  return {
    status: "success",
    composite: "stress_test_decision",
    pipeline: ["evaluate_options_with_scenarios (baseline)", "scenariosim (stressed x steps)", "decisionmatrix.create_decision (per step)"],
    stress_variable: variable,
    variation,
    steps,
    baseline_winner: baseWinner,
    robustness_score: round4(robustness),
    robustness_pct: `${round2(robustness * 100)}%`,
    winner_flips: flips,
    first_flip_at_factor: firstFlipAt,
    per_step: perStep,
    baseline: { winner: base.winner, ranking: base.ranking, criteria: base.weights_used },
    methodology: {
      pipeline: `The baseline decision is computed, then '${variable}' is scaled by a shared factor from ${lo.toFixed(2)}x to ${hi.toFixed(2)}x across ${steps} steps (applied to every option's own baseline), re-ranking the options at each step.`,
      robustness: "Share of stress steps in which the baseline winner remains #1.",
      precision: "decimal.js (40 significant digits) end-to-end",
      deterministic: true,
    },
    notes: [
      "The stressed variable is scaled relative to each option's own baseline, preserving the differences between options.",
      "robustness_score = 1.0 means the winner never changes under the stress.",
    ],
    explanation:
      `Stressing '${variable}' by +/-${Math.round(variation * 100)}% across ${steps} steps, the baseline winner '${baseWinner}' ` +
      (flips === 0 ? `holds #1 in every scenario (fully robust).` : `changes in ${flips} of ${steps} steps (robustness ${round2(robustness * 100)}%; first flip at ${firstFlipAt}x).`),
  };
}

// ---------------------------------------------------------------------------
function clampInt(v, def, lo, hi) {
  if (v === undefined || v === null || v === "") return def;
  const n = parseInt(String(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }
function round2(n) { return Math.round(n * 100) / 100; }

// Guarded public entrypoints (a thrown StackError becomes a clean envelope).
function guard(fn) {
  return (args) => {
    try { return fn(args || {}); }
    catch (e) {
      if (e instanceof StackError) return errEnvelope(e.message, e.type, e.hint);
      return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema.");
    }
  };
}
export const composites = {
  plan_to_valuation: guard(plan_to_valuation),
  evaluate_options_with_scenarios: guard(evaluate_options_with_scenarios),
  stress_test_decision: guard(stress_test_decision),
};
