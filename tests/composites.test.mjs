// AgentStack composite-tool tests — the cross-domain logic that is unique to the
// suite (the underlying engines are tested in their own repos).
// Run:  node --test tests/   (Node 18+, only dependency is decimal.js)
import test from "node:test";
import assert from "node:assert/strict";
import { composites } from "../worker-src/composites.mjs";

const { plan_to_valuation, evaluate_options_with_scenarios, stress_test_decision } = composites;

// ---------------------------------------------------------------------------
// plan_to_valuation (ScenarioSim -> PrecisionCalc)
// ---------------------------------------------------------------------------

test("plan_to_valuation values a scenario cash-flow stream (NPV + IRR)", () => {
  const r = plan_to_valuation({
    template: "saas_growth",
    inputs: { starting_customers: 200, new_customers_per_period: 40, churn_rate: 0.03, arpu: 60 },
    horizon: 12, cashflow_metric: "mrr", rate: 0.01, initial_investment: 100000,
  });
  assert.equal(r.status, "success");
  assert.equal(r.composite, "plan_to_valuation");
  assert.equal(typeof r.valuation.npv, "number");
  assert.equal(r.cashflows[0], -100000);           // period 0 = -investment
  assert.equal(r.cashflows.length, 13);            // 0..12
  assert.ok(r.valuation.irr !== null);             // sign change -> IRR exists
  assert.ok(r.valuation.value_creating === (r.valuation.npv > 0));
});

test("plan_to_valuation is deterministic", () => {
  const a = JSON.stringify(plan_to_valuation({ template: "saas_growth", horizon: 12, cashflow_metric: "mrr", rate: 0.01, initial_investment: 50000 }));
  const b = JSON.stringify(plan_to_valuation({ template: "saas_growth", horizon: 12, cashflow_metric: "mrr", rate: 0.01, initial_investment: 50000 }));
  assert.equal(a, b);
});

test("plan_to_valuation skips IRR with a note when there is no sign change", () => {
  const r = plan_to_valuation({ template: "saas_growth", horizon: 6, cashflow_metric: "mrr", rate: 0.01 }); // no investment -> all positive
  assert.equal(r.status, "success");
  assert.equal(r.valuation.irr, null);
  assert.ok(r.notes.some((n) => /IRR/i.test(n)));
});

test("plan_to_valuation errors on an unknown cashflow_metric, listing options", () => {
  const r = plan_to_valuation({ template: "saas_growth", horizon: 6, cashflow_metric: "nonsense", rate: 0.01 });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "unknown_metric");
  assert.match(r.error.hint, /mrr|customers/);
});

test("plan_to_valuation surfaces a bad scenario as a simulate-stage error", () => {
  const r = plan_to_valuation({ template: "does_not_exist", cashflow_metric: "mrr", rate: 0.01 });
  assert.equal(r.status, "error");
  assert.equal(r.stage, "simulate");
});

test("plan_to_valuation requires cashflow_metric and rate", () => {
  assert.equal(plan_to_valuation({ template: "saas_growth", rate: 0.01 }).error.type, "missing_parameter");
  assert.equal(plan_to_valuation({ template: "saas_growth", cashflow_metric: "mrr" }).error.type, "missing_parameter");
});

// ---------------------------------------------------------------------------
// evaluate_options_with_scenarios (ScenarioSim -> DecisionMatrix)
// ---------------------------------------------------------------------------

test("evaluate_options_with_scenarios projects options then ranks the outcomes", () => {
  const r = evaluate_options_with_scenarios({
    template: "saas_growth", horizon: 12,
    options: [
      { name: "Aggressive", inputs: { new_customers_per_period: 60, churn_rate: 0.05 } },
      { name: "Lean", inputs: { new_customers_per_period: 20, churn_rate: 0.02 } },
      { name: "Balanced", inputs: { new_customers_per_period: 40, churn_rate: 0.035 } },
    ],
    criteria: [{ metric: "ending_mrr", weight: 3, direction: "benefit" }, { metric: "total_churned_customers", weight: 1, direction: "cost" }],
  });
  assert.equal(r.status, "success");
  assert.equal(r.ranking.length, 3);
  assert.equal(r.options_evaluated.length, 3);
  assert.ok(r.winner.option);
  // Each option carries its underlying scenario key_results.
  for (const o of r.options_evaluated) assert.ok("ending_mrr" in o.key_results);
});

test("evaluate_options_with_scenarios errors on a criterion that isn't a key_result", () => {
  const r = evaluate_options_with_scenarios({
    template: "saas_growth", horizon: 6,
    options: [{ name: "A", inputs: {} }, { name: "B", inputs: { arpu: 80 } }],
    criteria: [{ metric: "not_a_metric", weight: 1 }],
  });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "unknown_metric");
});

test("evaluate_options_with_scenarios needs >=2 options and criteria", () => {
  assert.equal(evaluate_options_with_scenarios({ template: "saas_growth", options: [{ name: "A" }], criteria: [{ metric: "ending_mrr" }] }).error.type, "missing_parameter");
  assert.equal(evaluate_options_with_scenarios({ template: "saas_growth", options: [{ name: "A" }, { name: "B" }] }).error.type, "missing_parameter");
});

// ---------------------------------------------------------------------------
// stress_test_decision (ScenarioSim sensitivity x DecisionMatrix)
// ---------------------------------------------------------------------------

test("stress_test_decision reports baseline winner + robustness", () => {
  const r = stress_test_decision({
    template: "saas_growth", horizon: 12,
    options: [
      { name: "Aggressive", inputs: { new_customers_per_period: 60, churn_rate: 0.05 } },
      { name: "Lean", inputs: { new_customers_per_period: 20, churn_rate: 0.02 } },
    ],
    criteria: [{ metric: "ending_mrr", weight: 3 }],
    stress: { variable: "churn_rate", variation: 0.5, steps: 5 },
  });
  assert.equal(r.status, "success");
  assert.ok(r.baseline_winner);
  assert.ok(r.robustness_score >= 0 && r.robustness_score <= 1);
  assert.equal(r.per_step.length, 5);
  assert.equal(r.winner_flips + r.per_step.filter((s) => s.winner === r.baseline_winner).length, 5);
});

test("stress_test_decision requires a stress.variable", () => {
  const r = stress_test_decision({
    template: "saas_growth",
    options: [{ name: "A" }, { name: "B", inputs: { arpu: 80 } }],
    criteria: [{ metric: "ending_mrr", weight: 1 }],
  });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "missing_parameter");
});

test("stress_test_decision is deterministic", () => {
  const args = {
    template: "saas_growth", horizon: 12,
    options: [{ name: "A", inputs: { churn_rate: 0.05 } }, { name: "B", inputs: { churn_rate: 0.02 } }],
    criteria: [{ metric: "ending_mrr", weight: 1 }],
    stress: { variable: "churn_rate", variation: 0.4, steps: 4 },
  };
  assert.equal(JSON.stringify(stress_test_decision(args)), JSON.stringify(stress_test_decision(args)));
});
