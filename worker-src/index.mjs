// AgentStack MCP — Cloudflare Pages Function (_worker.js advanced mode).
//
// One deterministic reasoning stack for AI agents, served over Streamable HTTP
// at /mcp. It bundles the SAME engines that power three standalone servers:
//
//   sim_*    -> ScenarioSim   (what-if / scenario simulation)
//   decide_* -> DecisionMatrix (multi-criteria decision analysis)
//   calc_*   -> PrecisionCalc  (exact finance / business math)
//
// plus CROSS-DOMAIN composite tools that chain them (simulate -> decide ->
// compute). One API key + one quota covers everything. Tools are namespaced and
// can be filtered with ?profile=finance|decision|simulation|all (default all).
//
// The engines are imported directly (no HTTP proxying): zero added latency, no
// cascading failure, still 100% deterministic. Billing/quota lives only in KV
// and never touches the math. No KV bound -> fails open (free tier).
import * as SS from "./engines/scenariosim.mjs";
import * as DM from "./engines/decisionmatrix.mjs";
import * as PC from "./engines/precisioncalc.mjs";
import { composites, errEnvelope } from "./composites.mjs";
import * as B from "./billing.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "AgentStack", version: "1.0.0-edge" };
const STANDALONE = {
  simulation: "https://scenariosim-mcp.pages.dev/mcp",
  decision: "https://decisionmatrix-mcp.pages.dev/mcp",
  finance: "https://precisioncalc-mcp.pages.dev/mcp",
};

// PrecisionCalc engine fns throw on bad input (unlike the self-guarded others).
function pcWrap(fn) {
  return async (a) => {
    try { return await fn(a); }
    catch (e) { return errEnvelope(e.message, e.type || "calc_error", e.hint || "Verify input types and values."); }
  };
}

const str = { type: "string" }, num = { type: "number" }, int = { type: "integer" }, obj = { type: "object" };

// ---- Tool registry ----------------------------------------------------------
// Each tool: { ns, profiles[], description, inputSchema, handler }.
// profiles gate which tools a client sees for a given ?profile=.
const T = (ns, profiles, description, inputSchema, handler) => ({ ns, profiles, description, inputSchema, handler });

const TOOLS = {
  // ---- meta (always available) ----
  list_capabilities: T("meta", ["all", "finance", "decision", "simulation"],
    "Discovery: the three namespaces (sim_*, decide_*, calc_*), the cross-domain composite tools, the available ?profile= filters, and links to the standalone servers. Call this first to see everything AgentStack exposes. No parameters.",
    { type: "object", properties: {} }, () => listCapabilities()),
  health_check: T("meta", ["all", "finance", "decision", "simulation"],
    "Aggregated health/status for the whole stack (all three engines + composites). No parameters.",
    { type: "object", properties: {} }, () => healthCheck()),

  // ---- sim_* : ScenarioSim (what-if / scenario simulation) ----
  sim_run: T("sim", ["all", "simulation"],
    "SIMULATE. Deterministic what-if projection from a template (saas_growth, pricing_change, churn_impact, cost_reduction, hiring_plan, cash_runway, unit_economics, marketing_funnel, compound_growth) or a free-form 'metrics' model. Returns per-period projections, key_results, assumptions_used, methodology, and an explanation.",
    { type: "object", properties: { template: str, inputs: obj, metrics: { type: "array", items: obj }, horizon: int, period_label: str } }, (a) => SS.run_scenario(a)),
  sim_sensitivity: T("sim", ["all", "simulation"],
    "SIMULATE. Vary one or more scenario inputs and show the impact on a target output metric (one-at-a-time), with elasticity + most-influential ranking. Requires 'template' and 'variable' (or 'variables').",
    { type: "object", properties: { template: str, inputs: obj, target_metric: str, variable: str, variables: { type: "array", items: obj }, variation: num, steps: int, values: { type: "array", items: num }, min: num, max: num, horizon: int, period_label: str }, required: ["template"] }, (a) => SS.sensitivity_analysis(a)),
  sim_break_even: T("sim", ["all", "simulation"],
    "SIMULATE. Solve for the scenario input value required to make an output metric hit a target value (deterministic bisection). Requires 'template', 'solve_for', 'target_value'.",
    { type: "object", properties: { template: str, inputs: obj, solve_for: str, target_metric: str, target_value: num, bounds: { type: "array", items: num }, horizon: int, period_label: str }, required: ["template", "solve_for", "target_value"] }, (a) => SS.break_even(a)),
  sim_compare: T("sim", ["all", "simulation"],
    "SIMULATE. Run 2-3 scenarios and compare their key_results side by side with deltas vs the first (baseline). Optional 'compare_metric' + 'goal' (max|min) picks a winner.",
    { type: "object", properties: { scenarios: { type: "array", items: obj }, compare_metric: str, goal: str, horizon: int, include_projections: { type: "boolean" } }, required: ["scenarios"] }, (a) => SS.compare_scenarios(a)),
  sim_list_templates: T("sim", ["all", "simulation"],
    "SIMULATE. List every scenario template (inputs, defaults, outputs) plus the custom-model format and period labels. No parameters.",
    { type: "object", properties: {} }, () => SS.list_templates()),

  // ---- decide_* : DecisionMatrix (multi-criteria decision analysis) ----
  decide: T("decide", ["all", "decision"],
    "DECIDE. Rank named options against weighted criteria and return the winner, full ranking, per-criterion breakdowns, methodology, weights, and an explanation. Provide options, criteria [{name, weight, direction}], and a scores matrix. method: weighted_sum (default) | weighted_product | topsis.",
    { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: obj, method: str }, required: ["options", "criteria", "scores"] }, (a) => DM.create_decision(a)),
  decide_score: T("decide", ["all", "decision"],
    "DECIDE. Return the full normalized scored matrix (per-option, per-criterion) + ranking when scores are supplied separately, without the winner narrative.",
    { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: obj, method: str }, required: ["options", "criteria", "scores"] }, (a) => DM.score_options(a)),
  decide_sensitivity: T("decide", ["all", "decision"],
    "DECIDE. Test how robust the decision winner is to changes in CRITERIA WEIGHTS (distinct from sim_sensitivity, which varies scenario inputs). Sweeps each weight +/-variation and reports a robustness score + flip points.",
    { type: "object", properties: { options: { type: "array" }, criteria: { type: "array" }, scores: obj, method: str, variation: num, steps: int }, required: ["options", "criteria", "scores"] }, (a) => DM.sensitivity_analysis(a)),
  decide_compare_two: T("decide", ["all", "decision"],
    "DECIDE. Head-to-head comparison of exactly two options with per-criterion win counts and margin. Pass option_a/option_b (or a 2-element options array), criteria, and scores.",
    { type: "object", properties: { option_a: str, option_b: str, options: { type: "array" }, criteria: { type: "array" }, scores: obj, method: str }, required: ["criteria", "scores"] }, (a) => DM.compare_two(a)),
  decide_list_methods: T("decide", ["all", "decision"],
    "DECIDE. List the scoring methods (weighted_sum, weighted_product, topsis) with normalization details and when to use each. No parameters.",
    { type: "object", properties: {} }, () => DM.list_methods()),

  // ---- calc_* : PrecisionCalc (exact finance / business math) ----
  calc_metric: T("calc", ["all", "finance"],
    "COMPUTE. Exact business/SaaS/finance metric: ltv, cac, ltv_cac_ratio, payback_period_months, contribution_margin, gross_margin, churn_rate, mrr_growth_rate, arr, break_even_units, nrr, grr, rule_of_40, magic_number. Rates/margins are decimals (0.05=5%). Call calc_list_metrics for schemas.",
    { type: "object", properties: { metric: str, params: obj, currency: str }, required: ["metric", "params"] }, pcWrap((a) => PC.calculate_metric(a))),
  calc_list_metrics: T("calc", ["all", "finance"],
    "COMPUTE. List every supported metric with descriptions and required/optional params. No parameters.",
    { type: "object", properties: {} }, () => PC.list_metrics()),
  calc_currency_convert: T("calc", ["all", "finance"],
    "COMPUTE. Convert between major currencies (USD, EUR, GBP, JPY, CAD, AUD, CHF, CNY, INR) with Decimal precision. Static offline table by default; live/historical ECB rates via date/live=true.",
    { type: "object", properties: { amount: num, from_currency: str, to_currency: str, date: str, live: { type: "boolean" } }, required: ["amount", "from_currency", "to_currency"] }, pcWrap((a) => PC.currency_convert(a))),
  calc_business_days: T("calc", ["all", "finance"],
    "COMPUTE. Business-day arithmetic honoring weekends + regional holidays. operation: add_business_days | count_business_days | next_business_day | previous_business_day. region: US | UK | EU | NONE.",
    { type: "object", properties: { operation: str, start_date: str, days: int, end_date: str, region: str, custom_holidays: { type: "array", items: str } }, required: ["operation", "start_date"] }, pcWrap((a) => PC.business_days(a))),
  calc_compound_growth: T("calc", ["all", "finance"],
    "COMPUTE. Compound-interest/growth math. operation: future_value | present_value | cagr. rate is annual decimal; compounding: daily|weekly|monthly|quarterly|semiannually|annually|continuous.",
    { type: "object", properties: { operation: str, rate: num, years: num, present_value: num, future_value: num, begin_value: num, end_value: num, compounding: str, currency: str }, required: ["operation"] }, pcWrap((a) => PC.compound_growth(a))),
  calc_npv: T("calc", ["all", "finance"],
    "COMPUTE. Net Present Value (discounted cash flow). NPV = sum(CF_t/(1+rate)^t); cashflows[0] is period 0 (usually the negative outlay).",
    { type: "object", properties: { rate: num, cashflows: { type: "array", items: num }, currency: str }, required: ["rate", "cashflows"] }, pcWrap((a) => PC.net_present_value(a))),
  calc_irr: T("calc", ["all", "finance"],
    "COMPUTE. Internal Rate of Return: per-period rate where NPV=0 (Newton + bisection). Requires a sign change in cashflows.",
    { type: "object", properties: { cashflows: { type: "array", items: num }, guess: num }, required: ["cashflows"] }, pcWrap((a) => PC.internal_rate_of_return(a))),
  calc_loan_amortization: T("calc", ["all", "finance"],
    "COMPUTE. Level-payment loan: monthly payment, total interest, payoff, and (optional) full schedule.",
    { type: "object", properties: { principal: num, annual_rate: num, term_months: int, extra_payment: num, currency: str, include_schedule: { type: "boolean" } }, required: ["principal", "annual_rate", "term_months"] }, pcWrap((a) => PC.loan_amortization(a))),
  calc_depreciation: T("calc", ["all", "finance"],
    "COMPUTE. Asset depreciation schedule. method: straight_line | declining_balance | sum_of_years_digits.",
    { type: "object", properties: { method: str, cost: num, salvage_value: num, useful_life_years: int, currency: str }, required: ["method", "cost", "salvage_value", "useful_life_years"] }, pcWrap((a) => PC.depreciation(a))),

  // ---- composite_* : cross-domain (the reason to use the stack) ----
  plan_to_valuation: T("composite", ["all", "finance", "simulation"],
    "COMPOSITE (simulate -> compute). Project a scenario, take a per-period cash-flow line from its projections ('cashflow_metric', e.g. 'mrr' or 'net_burn'), and value it exactly: NPV at a discount 'rate', IRR, and undiscounted total. Optional 'initial_investment' becomes the period-0 outflow (needed for IRR). Combines ScenarioSim + PrecisionCalc.",
    { type: "object", properties: { template: str, inputs: obj, metrics: { type: "array", items: obj }, horizon: int, period_label: str, cashflow_metric: str, rate: num, initial_investment: num, currency: str }, required: ["template", "cashflow_metric", "rate"] }, (a) => composites.plan_to_valuation(a)),
  evaluate_options_with_scenarios: T("composite", ["all", "simulation", "decision"],
    "COMPOSITE (simulate -> decide). Project each option as its own scenario, then rank the options against weighted criteria drawn from the scenario OUTCOMES. Provide a base 'template', an 'options' array ([{name, inputs}]), and 'criteria' ([{metric, weight, direction}]) where each metric is a scenario key_result. Combines ScenarioSim + DecisionMatrix.",
    { type: "object", properties: { template: str, inputs: obj, horizon: int, period_label: str, method: str, options: { type: "array", items: obj }, criteria: { type: "array", items: obj } }, required: ["options", "criteria"] }, (a) => composites.evaluate_options_with_scenarios(a)),
  stress_test_decision: T("composite", ["all", "decision", "simulation"],
    "COMPOSITE (simulate x decide). Take an options-vs-scenarios decision and stress ONE scenario assumption across a range applied to every option; report how often the baseline winner survives (robustness) and where it flips. Same args as evaluate_options_with_scenarios plus 'stress': {variable, variation, steps}.",
    { type: "object", properties: { template: str, inputs: obj, horizon: int, period_label: str, method: str, options: { type: "array", items: obj }, criteria: { type: "array", items: obj }, stress: obj }, required: ["options", "criteria", "stress"] }, (a) => composites.stress_test_decision(a)),
};

const PROFILES = ["all", "finance", "decision", "simulation"];
function toolsForProfile(profile) {
  const p = PROFILES.includes(profile) ? profile : "all";
  return Object.entries(TOOLS).filter(([, s]) => s.profiles.includes(p));
}

function listCapabilities() {
  const byNs = {};
  for (const [name, s] of Object.entries(TOOLS)) (byNs[s.ns] ||= []).push(name);
  return {
    status: "success",
    server: "AgentStack",
    tagline: "One deterministic reasoning stack for AI agents: simulate -> decide -> compute.",
    namespaces: {
      "sim_* (ScenarioSim)": { purpose: "What-if / scenario simulation over time.", tools: byNs.sim },
      "decide_* (DecisionMatrix)": { purpose: "Multi-criteria decision analysis.", tools: byNs.decide },
      "calc_* (PrecisionCalc)": { purpose: "Exact finance / business math.", tools: byNs.calc },
      "composite_* (cross-domain)": { purpose: "Chain the three engines for reasoning no single server can do.", tools: byNs.composite },
      meta: { purpose: "Discovery + health.", tools: byNs.meta },
    },
    composite_tools: {
      plan_to_valuation: "simulate a plan, then value its cash-flow stream (NPV/IRR).",
      evaluate_options_with_scenarios: "project each option, then rank the outcomes.",
      stress_test_decision: "stress a scenario assumption and see if the chosen option holds.",
    },
    profiles: {
      all: "Every tool (default).",
      finance: "calc_* + plan_to_valuation + meta.",
      decision: "decide_* + evaluate_options_with_scenarios + stress_test_decision + meta.",
      simulation: "sim_* + all composites + meta.",
      usage: "Append ?profile=finance (etc.) to the /mcp URL to load only that subset — reduces tool-selection noise for focused agents.",
    },
    standalone_servers: STANDALONE,
    tool_count: Object.keys(TOOLS).length,
    deterministic: true,
    notes: [
      "One API key + one daily quota covers all three products and the composites.",
      "All math is 100% deterministic (decimal.js, 40-digit precision).",
    ],
  };
}

function healthCheck() {
  const pc = safe(() => PC.health_check());
  const dm = safe(() => DM.health_check());
  const ss = safe(() => SS.health_check());
  return {
    status: "ok",
    server: "AgentStack",
    version: SERVER_INFO.version,
    deterministic: true,
    stateless: true,
    precision: "decimal.js (40 significant digits)",
    engines: {
      scenariosim: ss ? { version: ss.version, templates: ss.templates?.length } : "ok",
      decisionmatrix: dm ? { version: dm.version, methods: dm.methods } : "ok",
      precisioncalc: pc ? { version: pc.version || pc.server_version, metrics: pc.metrics_supported || pc.metrics } : "ok",
    },
    tool_count: Object.keys(TOOLS).length,
    profiles: PROFILES,
    composite_tools: ["plan_to_valuation", "evaluate_options_with_scenarios", "stress_test_decision"],
    runtime: "cloudflare-pages-functions",
  };
}
function safe(fn) { try { return fn(); } catch { return null; } }

const PAID_ONLY_TOOLS = new Set(); // none: paid plans only raise the quota.

async function runTool(name, args) {
  const spec = TOOLS[name];
  if (!spec) return errEnvelope(`Unknown tool '${name}'.`, "unknown_tool", `Available: ${Object.keys(TOOLS).join(", ")}.`);
  try { return await spec.handler(args || {}); }
  catch (e) { return errEnvelope(`Unexpected error: ${e.message}`, "internal_error", "Verify the shape/types of your inputs against the tool schema."); }
}

const meter = { total: 0, rejected: 0, byTool: {}, started: 0 };

async function handleRpc(msg, ctx, env, profile) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === "notifications/initialized") return null;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list")
    return reply(id, { tools: toolsForProfile(profile).map(([name, s]) => ({ name, description: s.description, inputSchema: s.inputSchema })) });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (!TOOLS[name]) return rpcError(id, -32602, `Unknown tool '${name}'.`);
    if (ctx.plan === "revoked" || ctx.plan === "invalid_key") { meter.rejected++; return toolResult(id, B.upsell(env, ctx.plan, { tool: name })); }
    if (ctx.plan === "free" && PAID_ONLY_TOOLS.has(name)) { meter.rejected++; return toolResult(id, B.upsell(env, "upgrade_required", { tool: name })); }
    const q = await B.consumeQuota(env, ctx.identity, ctx.limit);
    if (!q.allowed) { meter.rejected++; return toolResult(id, B.upsell(env, "quota_exceeded", { tool: name, usage: { plan: ctx.plan, used: q.used, limit: q.limit, remaining: 0, resets: "daily 00:00 UTC" } })); }
    meter.total++; meter.byTool[name] = (meter.byTool[name] || 0) + 1;
    const result = await runTool(name, args);
    if (result && typeof result === "object") result.quota = { plan: ctx.plan, used: q.used, limit: q.limit, remaining: q.remaining };
    return toolResult(id, result);
  }
  if (typeof id === "undefined" || id === null) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}
function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(id, o) { return reply(id, { content: [{ type: "text", text: JSON.stringify(o, null, 2) }], structuredContent: o, isError: o?.status === "error" }); }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
};
function sse(o, extra = {}) { return new Response(`event: message\ndata: ${JSON.stringify(o)}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "mcp-session-id": "agentstack-stateless", ...CORS, ...extra } }); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
function redirect(url) { return new Response(null, { status: 302, headers: { Location: url, ...CORS } }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }); }

function successPage(key, plan, reused) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentStack — your API key</title><style>
body{margin:0;background:#0b0f1a;color:#e7ecf5;font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Arial;line-height:1.6}
.wrap{max-width:680px;margin:0 auto;padding:56px 20px}a{color:#63a4ff}
.k{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:16px;font-size:16px;word-break:break-all;color:#7ae0c6}
.btn{cursor:pointer;background:#7ae0c6;color:#06231a;font-weight:700;border:0;border-radius:9px;padding:9px 14px;margin-top:12px}
pre{background:#0e1424;border:1px solid #20293f;border-radius:12px;padding:14px;overflow:auto;font-size:13px;color:#d7e2ff}
.badge{display:inline-block;color:#7ae0c6;border:1px solid #20293f;border-radius:999px;padding:4px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.1em}
</style></head><body><div class="wrap">
<span class="badge">Payment successful · ${plan} plan</span>
<h1>🎉 Your AgentStack API key</h1>
<p>Save this now — it's shown once. It covers all three products + composites. Send it as the <code>X-API-Key</code> header.</p>
<div class="k" id="key">${key}</div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('key').innerText);this.textContent='Copied ✓'">Copy key</button>
${reused ? '<p style="color:#ffcf6b">(This session was already provisioned; same key returned.)</p>' : ""}
<h3>Use it</h3>
<pre>{
  "mcpServers": {
    "agentstack": {
      "url": "https://agentstack-mcp.pages.dev/mcp",
      "headers": { "X-API-Key": "${key}" }
    }
  }
}</pre>
<p><a href="/#pricing">← Back to AgentStack</a> · <a href="/portal?key=${key}">Manage billing</a></p>
</div></body></html>`;
}

export default {
  async fetch(request, env) {
    if (!meter.started) meter.started = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/googledce1e0dc1be5381e.html")
      return new Response("google-site-verification: googledce1e0dc1be5381e.html", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

    if (path === "/checkout") {
      const plan = (url.searchParams.get("plan") || "starter").toLowerCase();
      if (plan !== "starter" && plan !== "pro") return html("<p>Unknown plan. <a href='/#pricing'>See pricing</a>.</p>", 400);
      try { return redirect(await B.createCheckout(env, plan)); }
      catch (e) { return html(`<p>Checkout error: ${e.message}. <a href="/#pricing">Back</a></p>`, 500); }
    }
    if (path === "/success") {
      const sid = url.searchParams.get("session_id");
      if (!sid) return html("<p>Missing session id. <a href='/#pricing'>Back</a></p>", 400);
      try { const p = await B.provisionFromSession(env, sid); return html(successPage(p.key, p.plan, p.reused)); }
      catch (e) { return html(`<p>Could not verify payment yet: ${e.message}. If you just paid, refresh in a moment. <a href="/#pricing">Back</a></p>`, 402); }
    }
    if (path === "/portal") {
      const key = url.searchParams.get("key") || request.headers.get("x-api-key");
      try { return redirect(await B.createPortal(env, key)); }
      catch (e) { return html(`<p>${e.message} <a href="/#pricing">Back</a></p>`, 400); }
    }
    if (path === "/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      const payload = await request.text();
      const ok = await B.verifyStripeSignature(env, payload, request.headers.get("stripe-signature"));
      if (!ok) return json({ error: "invalid signature" }, 400);
      try { await B.handleWebhookEvent(env, JSON.parse(payload)); } catch (_) {}
      return json({ received: true });
    }
    if (path === "/metrics")
      return json({ status: "success", server: SERVER_INFO, usage: { uptime_seconds: Math.round((Date.now() - meter.started) / 1000), total_calls: meter.total, rejected: meter.rejected, by_tool: meter.byTool } });

    if (path === "/mcp" || path === "/mcp/") {
      if (request.method === "GET") return new Response("Method Not Allowed (no server-initiated stream)", { status: 405, headers: CORS });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });
      let payload;
      try { payload = await request.json(); }
      catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body must be valid JSON-RPC." } }, 400); }

      const profile = url.searchParams.get("profile") || "all";
      const who = await B.identify(request, env);
      const limits = B.planLimits(env);
      who.limit = who.plan === "pro" ? limits.pro : who.plan === "starter" ? limits.starter : limits.free;

      if (Array.isArray(payload)) {
        const out = [];
        for (const m of payload) { const r = await handleRpc(m, who, env, profile); if (r) out.push(r); }
        return out.length ? sse(out) : new Response(null, { status: 202, headers: CORS });
      }
      const resp = await handleRpc(payload, who, env, profile);
      if (resp === null) return new Response(null, { status: 202, headers: CORS });
      return sse(resp);
    }

    return env.ASSETS.fetch(request);
  },
};
