#!/usr/bin/env node
// AgentStack MCP — local stdio server (self-host / Glama-runnable).
// Wraps the same vendored engines + composites as the hosted edge worker and
// speaks MCP over newline-delimited JSON-RPC on stdio. No network, no state.
// Profile selection via env: AGENTSTACK_PROFILE=finance|decision|simulation|all.
import readline from "node:readline";
import * as SS from "./worker-src/engines/scenariosim.mjs";
import * as DM from "./worker-src/engines/decisionmatrix.mjs";
import * as PC from "./worker-src/engines/precisioncalc.mjs";
import { composites, errEnvelope } from "./worker-src/composites.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "AgentStack", version: "1.0.0" };
const PROFILE = process.env.AGENTSTACK_PROFILE || "all";

const s = { type: "string" }, n = { type: "number" }, i = { type: "integer" }, o = { type: "object" };
const pcWrap = (fn) => (a) => { try { return fn(a); } catch (e) { return errEnvelope(e.message, e.type || "calc_error", e.hint || null); } };
const T = (ns, profiles, description, inputSchema, handler) => ({ ns, profiles, description, inputSchema, handler });

const TOOLS = {
  list_capabilities: T("meta", ["all", "finance", "decision", "simulation"], "Discovery: namespaces (sim_*, decide_*, calc_*), composite tools, and profiles.", { type: "object", properties: {} }, () => capabilities()),
  health_check: T("meta", ["all", "finance", "decision", "simulation"], "Aggregated health for the whole stack.", { type: "object", properties: {} }, () => health()),

  sim_run: T("sim", ["all", "simulation"], "SIMULATE. Deterministic what-if projection from a template or free-form 'metrics' model.", { type: "object", properties: { template: s, inputs: o, metrics: { type: "array", items: o }, horizon: i, period_label: s } }, (a) => SS.run_scenario(a)),
  sim_sensitivity: T("sim", ["all", "simulation"], "SIMULATE. Vary scenario inputs and show impact on a target metric.", { type: "object", properties: { template: s, inputs: o, target_metric: s, variable: s, variables: { type: "array" }, variation: n, steps: i, horizon: i, period_label: s }, required: ["template"] }, (a) => SS.sensitivity_analysis(a)),
  sim_break_even: T("sim", ["all", "simulation"], "SIMULATE. Solve for the input value that makes a metric hit a target.", { type: "object", properties: { template: s, inputs: o, solve_for: s, target_metric: s, target_value: n, bounds: { type: "array" }, horizon: i, period_label: s }, required: ["template", "solve_for", "target_value"] }, (a) => SS.break_even(a)),
  sim_compare: T("sim", ["all", "simulation"], "SIMULATE. Compare 2-3 scenarios side by side.", { type: "object", properties: { scenarios: { type: "array" }, compare_metric: s, goal: s, horizon: i }, required: ["scenarios"] }, (a) => SS.compare_scenarios(a)),
  sim_list_templates: T("sim", ["all", "simulation"], "SIMULATE. List every scenario template with inputs and outputs.", { type: "object", properties: {} }, () => SS.list_templates()),

  decide: T("decide", ["all", "decision"], "DECIDE. Rank options against weighted criteria; returns winner, ranking, breakdowns, explanation.", { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: o, method: s }, required: ["options", "criteria", "scores"] }, (a) => DM.create_decision(a)),
  decide_score: T("decide", ["all", "decision"], "DECIDE. Full normalized scored matrix + ranking.", { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: o, method: s }, required: ["options", "criteria", "scores"] }, (a) => DM.score_options(a)),
  decide_sensitivity: T("decide", ["all", "decision"], "DECIDE. Robustness of the winner to CRITERIA-WEIGHT changes.", { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: o, method: s, variation: n, steps: i }, required: ["options", "criteria", "scores"] }, (a) => DM.sensitivity_analysis(a)),
  decide_compare_two: T("decide", ["all", "decision"], "DECIDE. Head-to-head between exactly two options.", { type: "object", properties: { option_a: s, option_b: s, options: { type: "array" }, criteria: { type: "array" }, scores: o, method: s }, required: ["criteria", "scores"] }, (a) => DM.compare_two(a)),
  decide_list_methods: T("decide", ["all", "decision"], "DECIDE. List scoring methods.", { type: "object", properties: {} }, () => DM.list_methods()),

  calc_metric: T("calc", ["all", "finance"], "COMPUTE. Exact business/SaaS/finance metric (ltv, cac, rule_of_40, nrr, ...).", { type: "object", properties: { metric: s, params: o, currency: s }, required: ["metric", "params"] }, pcWrap((a) => PC.calculate_metric(a))),
  calc_list_metrics: T("calc", ["all", "finance"], "COMPUTE. List supported metrics + schemas.", { type: "object", properties: {} }, () => PC.list_metrics()),
  calc_currency_convert: T("calc", ["all", "finance"], "COMPUTE. Convert currencies with Decimal precision.", { type: "object", properties: { amount: n, from_currency: s, to_currency: s, date: s, live: { type: "boolean" } }, required: ["amount", "from_currency", "to_currency"] }, pcWrap((a) => PC.currency_convert(a))),
  calc_business_days: T("calc", ["all", "finance"], "COMPUTE. Business-day arithmetic with holidays.", { type: "object", properties: { operation: s, start_date: s, days: i, end_date: s, region: s, custom_holidays: { type: "array" } }, required: ["operation", "start_date"] }, pcWrap((a) => PC.business_days(a))),
  calc_compound_growth: T("calc", ["all", "finance"], "COMPUTE. future_value | present_value | cagr.", { type: "object", properties: { operation: s, rate: n, years: n, present_value: n, future_value: n, begin_value: n, end_value: n, compounding: s, currency: s }, required: ["operation"] }, pcWrap((a) => PC.compound_growth(a))),
  calc_npv: T("calc", ["all", "finance"], "COMPUTE. Net Present Value.", { type: "object", properties: { rate: n, cashflows: { type: "array" }, currency: s }, required: ["rate", "cashflows"] }, pcWrap((a) => PC.net_present_value(a))),
  calc_irr: T("calc", ["all", "finance"], "COMPUTE. Internal Rate of Return.", { type: "object", properties: { cashflows: { type: "array" }, guess: n }, required: ["cashflows"] }, pcWrap((a) => PC.internal_rate_of_return(a))),
  calc_loan_amortization: T("calc", ["all", "finance"], "COMPUTE. Level-payment loan schedule.", { type: "object", properties: { principal: n, annual_rate: n, term_months: i, extra_payment: n, currency: s, include_schedule: { type: "boolean" } }, required: ["principal", "annual_rate", "term_months"] }, pcWrap((a) => PC.loan_amortization(a))),
  calc_depreciation: T("calc", ["all", "finance"], "COMPUTE. Depreciation schedule.", { type: "object", properties: { method: s, cost: n, salvage_value: n, useful_life_years: i, currency: s }, required: ["method", "cost", "salvage_value", "useful_life_years"] }, pcWrap((a) => PC.depreciation(a))),

  plan_to_valuation: T("composite", ["all", "finance", "simulation"], "COMPOSITE (simulate -> compute). Project a scenario, value its cash-flow line (NPV/IRR).", { type: "object", properties: { template: s, inputs: o, horizon: i, period_label: s, cashflow_metric: s, rate: n, initial_investment: n, currency: s }, required: ["template", "cashflow_metric", "rate"] }, (a) => composites.plan_to_valuation(a)),
  evaluate_options_with_scenarios: T("composite", ["all", "simulation", "decision"], "COMPOSITE (simulate -> decide). Project each option, rank the outcomes.", { type: "object", properties: { template: s, inputs: o, horizon: i, period_label: s, method: s, options: { type: "array" }, criteria: { type: "array" } }, required: ["options", "criteria"] }, (a) => composites.evaluate_options_with_scenarios(a)),
  stress_test_decision: T("composite", ["all", "decision", "simulation"], "COMPOSITE (simulate x decide). Stress a scenario assumption and see if the winner holds.", { type: "object", properties: { template: s, inputs: o, horizon: i, period_label: s, method: s, options: { type: "array" }, criteria: { type: "array" }, stress: o }, required: ["options", "criteria", "stress"] }, (a) => composites.stress_test_decision(a)),
};

function visible() { const p = ["all", "finance", "decision", "simulation"].includes(PROFILE) ? PROFILE : "all"; return Object.entries(TOOLS).filter(([, t]) => t.profiles.includes(p)); }
function capabilities() { const ns = {}; for (const [name, t] of Object.entries(TOOLS)) (ns[t.ns] ||= []).push(name); return { status: "success", server: "AgentStack", namespaces: ns, profile: PROFILE, tool_count: Object.keys(TOOLS).length, deterministic: true }; }
function health() { const ss = try_(() => SS.health_check()), dm = try_(() => DM.health_check()), pc = try_(() => PC.health_check()); return { status: "ok", server: "AgentStack", version: SERVER_INFO.version, deterministic: true, engines: { scenariosim: ss?.version, decisionmatrix: dm?.version, precisioncalc: pc?.version || pc?.server_version }, tool_count: Object.keys(TOOLS).length }; }
function try_(f) { try { return f(); } catch { return null; } }

function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "ping") return reply(id, {});
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return null;
  if (method === "tools/list") return reply(id, { tools: visible().map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  if (method === "tools/call") {
    const spec = TOOLS[params?.name];
    if (!spec) return rpcError(id, -32602, `Unknown tool '${params?.name}'.`);
    let result;
    try { result = await spec.handler(params?.arguments || {}); }
    catch (e) { result = errEnvelope(`Unexpected error: ${e.message}`, "internal_error"); }
    return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: result?.status === "error" });
  }
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => { line = line.trim(); if (!line) return; let msg; try { msg = JSON.parse(line); } catch { return; } const res = await handle(msg); if (res) process.stdout.write(JSON.stringify(res) + "\n"); });
process.stderr.write(`AgentStack MCP stdio server ready (profile=${PROFILE})\n`);
