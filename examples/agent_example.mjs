// End-to-end AgentStack MCP client demo (Streamable HTTP).
//
//   node examples/agent_example.mjs                        # live hosted server
//   node examples/agent_example.mjs http://127.0.0.1:8788  # local `npm run dev`
//
// Shows the stack in action: a cross-domain composite (evaluate options via
// scenarios), then valuing the winner's plan, plus a plain namespaced call.
const BASE = (process.argv[2] || "https://agentstack-mcp.pages.dev").replace(/\/$/, "");
const ENDPOINT = `${BASE}/mcp`;

let idc = 0;
async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
  });
  const text = await res.text();
  const line = text.includes("data: ") ? text.split("data: ")[1].trim() : text.trim();
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(`RPC error: ${msg.error.message}`);
  return msg.result;
}
const tool = async (name, args) => (await call("tools/call", { name, arguments: args })).structuredContent;
const rule = (t) => console.log(`\n\x1b[1m== ${t} ==\x1b[0m`);

async function main() {
  console.log(`AgentStack MCP demo → ${ENDPOINT}`);

  rule("initialize + capabilities");
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  console.log(init.serverInfo);
  const cap = await tool("list_capabilities", {});
  console.log("Namespaces:", Object.keys(cap.namespaces).join(" | "));
  console.log("Composites:", Object.keys(cap.composite_tools).join(", "));

  rule("evaluate_options_with_scenarios — which growth plan wins on outcomes?");
  const decision = await tool("evaluate_options_with_scenarios", {
    template: "saas_growth", horizon: 12,
    options: [
      { name: "Aggressive", inputs: { new_customers_per_period: 60, churn_rate: 0.05, arpu: 60 } },
      { name: "Lean", inputs: { new_customers_per_period: 20, churn_rate: 0.02, arpu: 60 } },
      { name: "Balanced", inputs: { new_customers_per_period: 40, churn_rate: 0.035, arpu: 60 } },
    ],
    criteria: [
      { metric: "ending_mrr", weight: 3, direction: "benefit" },
      { metric: "total_churned_customers", weight: 1, direction: "cost" },
    ],
  });
  console.log(decision.explanation);
  console.table(decision.ranking.map((r) => ({ rank: r.rank, option: r.option, score: r.score })));

  rule("stress_test_decision — does the winner survive a churn shock?");
  const stress = await tool("stress_test_decision", {
    template: "saas_growth", horizon: 12,
    options: [
      { name: "Aggressive", inputs: { new_customers_per_period: 60, churn_rate: 0.05 } },
      { name: "Lean", inputs: { new_customers_per_period: 20, churn_rate: 0.02 } },
    ],
    criteria: [{ metric: "ending_mrr", weight: 3 }],
    stress: { variable: "churn_rate", variation: 0.5, steps: 5 },
  });
  console.log(stress.explanation);

  rule("plan_to_valuation — value the winning plan's MRR stream");
  const val = await tool("plan_to_valuation", {
    template: "saas_growth", horizon: 12,
    inputs: { new_customers_per_period: 60, churn_rate: 0.05, arpu: 60, starting_customers: 200 },
    cashflow_metric: "mrr", rate: 0.01, initial_investment: 150000,
  });
  console.log(val.explanation);
  console.log("NPV:", val.valuation.npv, "IRR:", val.valuation.irr_formatted);

  rule("calc_metric — an exact PrecisionCalc number");
  const ltv = await tool("calc_metric", { metric: "ltv", params: { arpu: 60, gross_margin: 0.8, churn_rate: 0.05 } });
  console.log("LTV result status:", ltv.status);
}

main().catch((e) => { console.error("Demo failed:", e.message); process.exit(1); });
