# AgentStack MCP

**One deterministic reasoning stack for AI agents** — behind a single
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) endpoint and one
API key:

> **simulate** (ScenarioSim) → **decide** (DecisionMatrix) → **compute** (PrecisionCalc)

plus **cross-domain composite tools** that chain the three. Every number runs
through [`decimal.js`](https://github.com/MikeMcl/decimal.js) at 40-digit precision
(**never floats**), so identical inputs always produce **byte-identical output**.
The server is **stateless** — no database, no sessions.

AgentStack bundles three standalone MCP servers so an agent installs **one**
server, uses **one** key, and can run reasoning that spans all three domains. It
imports the same engines directly (no HTTP proxying) — zero added latency, no
cascading failure.

## 🌐 Live hosted server (free, no install)

```
https://agentstack-mcp.pages.dev/mcp
```

```json
{ "mcpServers": { "agentstack": {
    "type": "http", "url": "https://agentstack-mcp.pages.dev/mcp" } } }
```

Free tier: no key, 20 calls/day per IP. Paid plans (**Starter $19/mo · 8,000/day**,
**Pro $59/mo · 80,000/day**) return an API key sent as `X-API-Key`. One key covers
all three products and the composites — about half the cost of subscribing to them
separately. Landing page: <https://agentstack-mcp.pages.dev>.

---

## The three namespaces (24 tools)

| namespace | engine | tools |
|-----------|--------|-------|
| `sim_*` | **ScenarioSim** — what-if / scenario simulation | `sim_run`, `sim_sensitivity`, `sim_break_even`, `sim_compare`, `sim_list_templates` |
| `decide_*` | **DecisionMatrix** — multi-criteria decision analysis | `decide`, `decide_score`, `decide_sensitivity`, `decide_compare_two`, `decide_list_methods` |
| `calc_*` | **PrecisionCalc** — exact finance/business math | `calc_metric`, `calc_list_metrics`, `calc_currency_convert`, `calc_business_days`, `calc_compound_growth`, `calc_npv`, `calc_irr`, `calc_loan_amortization`, `calc_depreciation` |
| meta | — | `list_capabilities`, `health_check` |

> **Note on two deliberately-namespaced collisions:** `sim_sensitivity` varies
> *scenario inputs*; `decide_sensitivity` varies *criteria weights*. They are
> different operations — the prefix disambiguates them for the agent.

## Composite tools — the reason to use the stack

Deterministic end-to-end; each chains engines that no single server bundles:

| Tool | Pipeline | What it does |
|------|----------|--------------|
| `plan_to_valuation` | simulate → compute | Project a scenario, take a per-period cash-flow line (`cashflow_metric`), and value it: **NPV** at a discount `rate`, **IRR**, undiscounted total. `initial_investment` becomes the period-0 outflow (needed for IRR). |
| `evaluate_options_with_scenarios` | simulate → decide | Project each option as its own scenario, then **rank** the options against weighted criteria drawn from the scenario **outcomes** (`key_results`). |
| `stress_test_decision` | simulate × decide | Stress one scenario assumption across **every** option and report how often the baseline winner survives (**robustness**) and where it flips. |

Composite responses report the `pipeline` they ran and carry each stage's
structured output, so an agent can drill into any step.

## Profiles — fight tool-selection noise

Append `?profile=` to the endpoint to load only a subset:

| profile | tools |
|---------|-------|
| `all` *(default)* | every tool (24) |
| `finance` | `calc_*` + `plan_to_valuation` + meta |
| `decision` | `decide_*` + `evaluate_options_with_scenarios` + `stress_test_decision` + meta |
| `simulation` | `sim_*` + all composites + meta |

```json
{ "mcpServers": { "agentstack": {
    "url": "https://agentstack-mcp.pages.dev/mcp?profile=finance" } } }
```

---

## Response envelope

Namespaced tools return the exact envelope of their underlying product. Composite
tools add `composite`, `pipeline`, per-stage blocks, `methodology`, `notes`, and a
plain-language `explanation`. Errors are always structured data:

```json
{ "status": "error", "error": { "type": "unknown_metric", "message": "...", "hint": "..." } }
```

Example — `plan_to_valuation` (trimmed):

```json
{
  "status": "success",
  "composite": "plan_to_valuation",
  "pipeline": ["scenariosim.run_scenario", "precisioncalc.net_present_value", "precisioncalc.internal_rate_of_return"],
  "scenario": { "template": "saas_growth", "horizon": 12, "key_results": { "ending_mrr": 26982.1 } },
  "cashflow_metric": "mrr",
  "cashflows": [-150000, 14040, 15600, "..."],
  "valuation": { "discount_rate": 0.01, "npv": 11157.386023, "irr": 0.02504, "value_creating": true },
  "explanation": "Projecting 'saas_growth' over 12 month(s) and valuing the 'mrr' stream at 1%/period gives an NPV of ..."
}
```

---

## Project structure

```
agentstack-mcp/
├── worker-src/
│   ├── index.mjs           # Cloudflare Pages Function: MCP transport, namespacing, profiles, billing
│   ├── composites.mjs      # the 3 cross-domain tools (simulate -> decide -> compute)
│   ├── billing.mjs         # Stripe + KV: one key / one quota for the whole stack
│   └── engines/            # vendored, unmodified product engines (100% deterministic)
│       ├── scenariosim.mjs
│       ├── decisionmatrix.mjs
│       └── precisioncalc.mjs
├── server.mjs              # local stdio MCP server (same engines + composites; AGENTSTACK_PROFILE env)
├── site/                   # landing page + mcp.json + llms.txt + _worker.js (built)
├── tests/composites.test.mjs
├── examples/agent_example.mjs
├── scripts/sync-engines.sh # re-vendor engines from the sibling repos
├── package.json · wrangler.toml · server.json · smithery.yaml · Dockerfile · LICENSE
└── README.md
```

**Why vendor the engines?** So this repo is self-contained and reproducible. The
engines are the *same* deterministic modules that power the three standalone
servers; `npm run sync-engines` re-copies them from the sibling repos when an
upstream change lands.

---

## Run it locally

```bash
git clone <your-fork> agentstack-mcp && cd agentstack-mcp
npm install
npm test                      # composite-logic tests (no network)
npm run dev                   # -> http://127.0.0.1:8788/mcp
node examples/agent_example.mjs            # hosted demo
node examples/agent_example.mjs http://127.0.0.1:8788
node server.mjs               # dependency-light stdio server (AGENTSTACK_PROFILE=finance to subset)
```

Quick manual call:

```bash
curl -s http://127.0.0.1:8788/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_capabilities","arguments":{}}}'
```

---

## Install via npm (stdio, no hosting)

Run the server locally over stdio with a single command — nothing to deploy:

```bash
npx -y agentstack-mcp
```

Claude Desktop / any stdio MCP client (`claude_desktop_config.json`):

```json
{ "mcpServers": { "agentstack": { "command": "npx", "args": ["-y", "agentstack-mcp"] } } }
```

This is the same deterministic engine as the hosted server, running on your machine.

## Client configuration

### Cursor — `~/.cursor/mcp.json`
```json
{ "mcpServers": { "agentstack": { "url": "https://agentstack-mcp.pages.dev/mcp" } } }
```
### Claude Desktop — `claude_desktop_config.json` (via `mcp-remote`)
```json
{ "mcpServers": { "agentstack": { "command": "npx", "args": ["-y", "mcp-remote", "https://agentstack-mcp.pages.dev/mcp"] } } }
```
### VS Code — `.vscode/mcp.json`
```json
{ "servers": { "agentstack": { "type": "http", "url": "https://agentstack-mcp.pages.dev/mcp" } } }
```
### Windsurf — `~/.codeium/windsurf/mcp_config.json`
```json
{ "mcpServers": { "agentstack": { "serverUrl": "https://agentstack-mcp.pages.dev/mcp" } } }
```
Add `"headers": { "X-API-Key": "ssak_live_..." }` once you have a key.

---

## Example composite payloads

Rank growth strategies on their projected outcomes:
```json
{ "name": "evaluate_options_with_scenarios", "arguments": {
  "template": "saas_growth", "horizon": 12,
  "options": [
    { "name": "Aggressive", "inputs": { "new_customers_per_period": 60, "churn_rate": 0.05 } },
    { "name": "Lean",       "inputs": { "new_customers_per_period": 20, "churn_rate": 0.02 } }
  ],
  "criteria": [
    { "metric": "ending_mrr", "weight": 3, "direction": "benefit" },
    { "metric": "total_churned_customers", "weight": 1, "direction": "cost" }
  ]
} }
```

Value a plan's MRR stream:
```json
{ "name": "plan_to_valuation", "arguments": {
  "template": "saas_growth", "horizon": 12,
  "inputs": { "new_customers_per_period": 60, "churn_rate": 0.05, "arpu": 60 },
  "cashflow_metric": "mrr", "rate": 0.01, "initial_investment": 150000
} }
```

Stress-test the decision:
```json
{ "name": "stress_test_decision", "arguments": {
  "template": "saas_growth", "horizon": 12,
  "options": [ { "name": "Aggressive", "inputs": { "churn_rate": 0.05 } },
               { "name": "Lean", "inputs": { "churn_rate": 0.02 } } ],
  "criteria": [ { "metric": "ending_mrr", "weight": 3 } ],
  "stress": { "variable": "churn_rate", "variation": 0.5, "steps": 5 }
} }
```

---

## Deploy on Cloudflare Pages

```bash
npm install
npx wrangler login
npm run deploy      # esbuild -> site/_worker.js, then wrangler pages deploy
```

Runs **fully free / private** with no bindings or secrets (fails open on the free
tier). For billing: bind a KV namespace `AGENTSTACK_KV`, set `PRICE_STARTER` /
`PRICE_PRO` in `[vars]`, and add Stripe secrets:

```bash
wrangler pages secret put STRIPE_SECRET_KEY    --project-name agentstack-mcp
wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name agentstack-mcp
```

Routes: `/mcp` (Streamable HTTP), `/checkout`, `/success`, `/portal`, `/webhook`, `/metrics`.

## Auth & rate limiting

Enforced in `worker-src/billing.mjs`: `identify()` reads `X-API-Key` /
`Authorization: Bearer` and falls back to per-IP free tier; `consumeQuota()` is a
KV daily counter (the single gating point). One key / one quota spans the whole
stack. Marked `NOTE (auth)` / `NOTE (rate limiting)` seams show where to swap in
JWT/mTLS or a token-bucket. None of it touches the deterministic math.

## Relationship to the standalone servers

AgentStack is **additive**, not a replacement. The three products keep running on
their own for single-domain use:

- ScenarioSim — <https://scenariosim-mcp.pages.dev/mcp>
- DecisionMatrix — <https://decisionmatrix-mcp.pages.dev/mcp>
- PrecisionCalc — <https://precisioncalc-mcp.pages.dev/mcp>

## License

MIT — see [LICENSE](./LICENSE).
