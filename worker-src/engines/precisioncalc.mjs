// PrecisionCalc tool engine (Cloudflare Worker port).
// Mirrors the Python calculation modules 1:1, using decimal.js for exact,
// arbitrary-precision arithmetic (never floats). Same tool contracts + envelope.
import Decimal from "decimal.js";

Decimal.set({ precision: 50 });
export const D = (x) => new Decimal(String(x));

// ---- errors ----------------------------------------------------------------
export class CalcError extends Error {
  constructor(message, { hint = null, type = "invalid_input" } = {}) {
    super(message);
    this.hint = hint;
    this.type = type;
  }
}

// ---- validation / coercion -------------------------------------------------
function toDec(name, value) {
  if (value === undefined || value === null || value === "")
    throw new CalcError(`Parameter '${name}' is required.`, { hint: `Provide a numeric '${name}'.`, type: "missing_parameter" });
  if (typeof value === "boolean")
    throw new CalcError(`Parameter '${name}' must be a number, got a boolean.`);
  try {
    const d = new Decimal(String(value));
    if (d.isNaN()) throw new Error("nan");
    return d;
  } catch {
    throw new CalcError(`Parameter '${name}' is not a valid number: ${JSON.stringify(value)}.`,
      { hint: "Pass a numeric value, e.g. 1000 or 0.05." });
  }
}
function reqPos(name, d) {
  if (d.lte(0)) throw new CalcError(`Parameter '${name}' must be greater than 0 (got ${d}).`, { hint: `Provide a positive '${name}'.` });
  return d;
}
function reqNonNeg(name, d) {
  if (d.lt(0)) throw new CalcError(`Parameter '${name}' must be zero or greater (got ${d}).`, { hint: `Provide a non-negative '${name}'.` });
  return d;
}
function need(params, key) {
  if (params == null || params[key] === undefined || params[key] === null)
    throw new CalcError(`Missing required parameter '${key}'.`,
      { hint: `Include '${key}' in params. See list_metrics for the full schema.`, type: "missing_parameter" });
  return params[key];
}

// ---- formatting ------------------------------------------------------------
const SYMBOLS = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5", CNY: "\u00a5", INR: "\u20b9", AUD: "A$", CAD: "C$", CHF: "CHF " };
const ZERO_DECIMAL = new Set(["JPY"]);
function quantize(d, places = 2) {
  return d.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}
function group(numStr) {
  const [intPart, frac] = numStr.split(".");
  const neg = intPart.startsWith("-");
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac !== undefined ? "." + frac : "");
}
function fmtMoney(d, currency = "USD", places = 2) {
  const prefix = SYMBOLS[currency] || "";
  const q = quantize(d, places).toFixed(places);
  const suffix = prefix ? "" : ` ${currency}`;
  return `${prefix}${group(q)}${suffix}`;
}
function fmtPercent(d, places = 4) {
  let s = d.times(100).toFixed(places);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return `${s}%`;
}
function normStr(d) {
  // full-precision plain notation, trailing zeros trimmed (parity with Python normalize)
  let s = d.toFixed();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

// ---- envelope --------------------------------------------------------------
function ok({ value, formatted_value, formula, inputs_used, unit, notes = [], extra = {} }) {
  const iu = {};
  for (const [k, v] of Object.entries(inputs_used)) iu[k] = v instanceof Decimal ? normStr(v) : v;
  const ex = {};
  for (const [k, v] of Object.entries(extra)) ex[k] = v instanceof Decimal ? normStr(v) : v;
  return {
    status: "success",
    value: value instanceof Decimal ? normStr(value) : value,
    formatted_value, formula, inputs_used: iu, unit, notes, ...ex,
  };
}
export function errEnvelope(message, type = "invalid_input", hint = null) {
  return { status: "error", error: { type, message, hint } };
}

// ===========================================================================
// METRICS
// ===========================================================================
export const METRIC_CATALOG = {
  ltv: { description: "Customer Lifetime Value: expected gross-profit per customer over their lifetime.", required_params: ["arpu", "churn_rate"], optional_params: { gross_margin: "1 (100%)" }, unit: "currency" },
  cac: { description: "Customer Acquisition Cost: sales+marketing spend / new customers.", required_params: ["total_spend", "new_customers"], optional_params: {}, unit: "currency" },
  ltv_cac_ratio: { description: "LTV:CAC ratio. Healthy SaaS benchmark >= 3.0.", required_params: ["ltv", "cac"], optional_params: {}, unit: "ratio" },
  payback_period_months: { description: "Months to recover CAC from monthly gross profit.", required_params: ["cac", "monthly_revenue_per_customer"], optional_params: { gross_margin: "1 (100%)" }, unit: "months" },
  contribution_margin: { description: "Revenue minus variable costs (absolute + %).", required_params: ["revenue", "variable_costs"], optional_params: {}, unit: "currency" },
  gross_margin: { description: "Gross margin ratio: (revenue - COGS) / revenue.", required_params: ["revenue", "cogs"], optional_params: {}, unit: "percent" },
  churn_rate: { description: "Customer churn: customers lost / customers at period start.", required_params: ["customers_lost", "customers_at_start"], optional_params: {}, unit: "percent" },
  mrr_growth_rate: { description: "MoM MRR growth: (end - start) / start.", required_params: ["beginning_mrr", "ending_mrr"], optional_params: {}, unit: "percent" },
  arr: { description: "Annual Recurring Revenue from MRR (MRR x 12).", required_params: ["mrr"], optional_params: {}, unit: "currency" },
  break_even_units: { description: "Units to cover fixed costs: fixed_costs / (price - variable_cost_per_unit).", required_params: ["fixed_costs", "price_per_unit", "variable_cost_per_unit"], optional_params: {}, unit: "units" },
  nrr: { description: "Net Revenue Retention: (start + expansion - contraction - churn) / start.", required_params: ["starting_mrr", "expansion_mrr", "contraction_mrr", "churned_mrr"], optional_params: {}, unit: "percent" },
  grr: { description: "Gross Revenue Retention: (start - contraction - churn) / start.", required_params: ["starting_mrr", "contraction_mrr", "churned_mrr"], optional_params: {}, unit: "percent" },
  rule_of_40: { description: "Rule of 40: revenue_growth_rate + profit_margin. Healthy >= 0.40.", required_params: ["growth_rate", "profit_margin"], optional_params: {}, unit: "percent" },
  magic_number: { description: "SaaS Magic Number: (QoQ revenue increase x 4) / prior-quarter S&M spend.", required_params: ["current_quarter_revenue", "prior_quarter_revenue", "prior_quarter_sm_spend"], optional_params: {}, unit: "ratio" },
};

const METRICS = {
  ltv(p, cur) {
    const arpu = toDec("arpu", need(p, "arpu"));
    const churn = reqPos("churn_rate", toDec("churn_rate", need(p, "churn_rate")));
    const gm = toDec("gross_margin", p.gross_margin ?? 1); reqNonNeg("gross_margin", gm);
    const value = arpu.times(gm).div(churn);
    const notes = ["LTV = (ARPU x gross_margin) / churn_rate.", "churn_rate and gross_margin are decimals (0.05 = 5%)."];
    if (p.gross_margin == null) notes.push("gross_margin defaulted to 1.0 (100%); revenue LTV, not gross-profit LTV.");
    return ok({ value, formatted_value: fmtMoney(value, cur), formula: "LTV = (ARPU * gross_margin) / churn_rate", inputs_used: { arpu, gross_margin: gm, churn_rate: churn }, unit: cur, notes });
  },
  cac(p, cur) {
    const spend = reqNonNeg("total_spend", toDec("total_spend", need(p, "total_spend")));
    const n = reqPos("new_customers", toDec("new_customers", need(p, "new_customers")));
    const value = spend.div(n);
    return ok({ value, formatted_value: fmtMoney(value, cur), formula: "CAC = total_spend / new_customers", inputs_used: { total_spend: spend, new_customers: n }, unit: cur, notes: ["Include fully-loaded sales + marketing spend for the period."] });
  },
  ltv_cac_ratio(p) {
    const ltv = reqNonNeg("ltv", toDec("ltv", need(p, "ltv")));
    const cac = reqPos("cac", toDec("cac", need(p, "cac")));
    const value = ltv.div(cac);
    const verdict = value.gte(3) ? "healthy (>=3)" : value.gte(1) ? "acceptable" : "unprofitable (<1)";
    return ok({ value, formatted_value: `${quantize(value).toFixed(2)}:1`, formula: "LTV:CAC = ltv / cac", inputs_used: { ltv, cac }, unit: "ratio", notes: [`Interpretation: ${verdict}.`, "SaaS rule of thumb: aim for 3:1 or higher."] });
  },
  payback_period_months(p) {
    const cac = reqNonNeg("cac", toDec("cac", need(p, "cac")));
    const mrpc = reqPos("monthly_revenue_per_customer", toDec("monthly_revenue_per_customer", need(p, "monthly_revenue_per_customer")));
    const gm = reqPos("gross_margin", toDec("gross_margin", p.gross_margin ?? 1));
    const value = cac.div(mrpc.times(gm));
    const notes = ["Payback = CAC / (monthly_revenue_per_customer x gross_margin)."];
    if (p.gross_margin == null) notes.push("gross_margin defaulted to 1.0; supply it for gross-profit payback.");
    return ok({ value, formatted_value: `${quantize(value).toFixed(2)} months`, formula: "payback_months = CAC / (monthly_revenue_per_customer * gross_margin)", inputs_used: { cac, monthly_revenue_per_customer: mrpc, gross_margin: gm }, unit: "months", notes });
  },
  contribution_margin(p, cur) {
    const rev = reqPos("revenue", toDec("revenue", need(p, "revenue")));
    const vc = reqNonNeg("variable_costs", toDec("variable_costs", need(p, "variable_costs")));
    const value = rev.minus(vc); const ratio = value.div(rev);
    return ok({ value, formatted_value: fmtMoney(value, cur), formula: "contribution_margin = revenue - variable_costs", inputs_used: { revenue: rev, variable_costs: vc }, unit: cur, notes: [`Contribution margin ratio = ${fmtPercent(ratio)}.`], extra: { margin_ratio: ratio, margin_ratio_formatted: fmtPercent(ratio) } });
  },
  gross_margin(p) {
    const rev = reqPos("revenue", toDec("revenue", need(p, "revenue")));
    const cogs = reqNonNeg("cogs", toDec("cogs", need(p, "cogs")));
    const value = rev.minus(cogs).div(rev);
    return ok({ value, formatted_value: fmtPercent(value), formula: "gross_margin = (revenue - cogs) / revenue", inputs_used: { revenue: rev, cogs }, unit: "percent", notes: ["Value is a ratio (0.60 = 60%). formatted_value is the percentage."] });
  },
  churn_rate(p) {
    const lost = reqNonNeg("customers_lost", toDec("customers_lost", need(p, "customers_lost")));
    const start = reqPos("customers_at_start", toDec("customers_at_start", need(p, "customers_at_start")));
    const value = lost.div(start); const notes = ["Value is a ratio for the measured period (e.g. monthly)."];
    if (lost.gt(start)) notes.push("customers_lost exceeds customers_at_start; churn > 100% - verify inputs.");
    return ok({ value, formatted_value: fmtPercent(value), formula: "churn_rate = customers_lost / customers_at_start", inputs_used: { customers_lost: lost, customers_at_start: start }, unit: "percent", notes });
  },
  mrr_growth_rate(p) {
    const b = reqPos("beginning_mrr", toDec("beginning_mrr", need(p, "beginning_mrr")));
    const e = reqNonNeg("ending_mrr", toDec("ending_mrr", need(p, "ending_mrr")));
    const value = e.minus(b).div(b);
    return ok({ value, formatted_value: fmtPercent(value), formula: "mrr_growth_rate = (ending_mrr - beginning_mrr) / beginning_mrr", inputs_used: { beginning_mrr: b, ending_mrr: e }, unit: "percent", notes: ["Negative value indicates contraction."] });
  },
  arr(p, cur) {
    const mrr = reqNonNeg("mrr", toDec("mrr", need(p, "mrr")));
    const value = mrr.times(12);
    return ok({ value, formatted_value: fmtMoney(value, cur), formula: "ARR = MRR * 12", inputs_used: { mrr }, unit: cur, notes: ["Assumes stable MRR across 12 months (no mid-year changes)."] });
  },
  break_even_units(p, cur) {
    const fixed = reqNonNeg("fixed_costs", toDec("fixed_costs", need(p, "fixed_costs")));
    const price = toDec("price_per_unit", need(p, "price_per_unit"));
    const varc = reqNonNeg("variable_cost_per_unit", toDec("variable_cost_per_unit", need(p, "variable_cost_per_unit")));
    const margin = price.minus(varc);
    if (margin.lte(0)) throw new CalcError("price_per_unit must exceed variable_cost_per_unit for a break-even to exist.", { hint: "Increase price_per_unit or reduce variable_cost_per_unit." });
    const exact = fixed.div(margin); const roundedUp = exact.ceil();
    return ok({ value: exact, formatted_value: `${roundedUp} units (exact: ${exact.toFixed(4)})`, formula: "break_even_units = fixed_costs / (price_per_unit - variable_cost_per_unit)", inputs_used: { fixed_costs: fixed, price_per_unit: price, variable_cost_per_unit: varc }, unit: "units", notes: [`Contribution per unit = ${fmtMoney(margin, cur)}.`, "Round up to fully cover fixed costs."], extra: { units_rounded_up: roundedUp } });
  },
  nrr(p) {
    const s = reqPos("starting_mrr", toDec("starting_mrr", need(p, "starting_mrr")));
    const exp = reqNonNeg("expansion_mrr", toDec("expansion_mrr", need(p, "expansion_mrr")));
    const c = reqNonNeg("contraction_mrr", toDec("contraction_mrr", need(p, "contraction_mrr")));
    const ch = reqNonNeg("churned_mrr", toDec("churned_mrr", need(p, "churned_mrr")));
    const value = s.plus(exp).minus(c).minus(ch).div(s);
    const verdict = value.gte("1.1") ? "excellent (>=1.1)" : value.gte(1) ? "healthy (>=1.0)" : "leaky (<1.0)";
    return ok({ value, formatted_value: fmtPercent(value), formula: "NRR = (starting_mrr + expansion - contraction - churn) / starting_mrr", inputs_used: { starting_mrr: s, expansion_mrr: exp, contraction_mrr: c, churned_mrr: ch }, unit: "percent", notes: [`Interpretation: ${verdict}.`, "Includes expansion/upsell revenue."] });
  },
  grr(p) {
    const s = reqPos("starting_mrr", toDec("starting_mrr", need(p, "starting_mrr")));
    const c = reqNonNeg("contraction_mrr", toDec("contraction_mrr", need(p, "contraction_mrr")));
    const ch = reqNonNeg("churned_mrr", toDec("churned_mrr", need(p, "churned_mrr")));
    const value = s.minus(c).minus(ch).div(s); const notes = ["Excludes expansion; GRR <= 100% by definition."];
    if (value.gt(1)) notes.push("Computed GRR > 100% - check contraction/churn are non-negative.");
    return ok({ value, formatted_value: fmtPercent(value), formula: "GRR = (starting_mrr - contraction - churn) / starting_mrr", inputs_used: { starting_mrr: s, contraction_mrr: c, churned_mrr: ch }, unit: "percent", notes });
  },
  rule_of_40(p) {
    const g = toDec("growth_rate", need(p, "growth_rate"));
    const m = toDec("profit_margin", need(p, "profit_margin"));
    const value = g.plus(m); const verdict = value.gte("0.40") ? "passes (>=40%)" : "below 40%";
    return ok({ value, formatted_value: fmtPercent(value), formula: "rule_of_40 = revenue_growth_rate + profit_margin", inputs_used: { growth_rate: g, profit_margin: m }, unit: "percent", notes: [`Interpretation: ${verdict}.`, "Both inputs are decimals (0.30 = 30%). Margin may be negative."] });
  },
  magic_number(p) {
    const cur = toDec("current_quarter_revenue", need(p, "current_quarter_revenue"));
    const prior = toDec("prior_quarter_revenue", need(p, "prior_quarter_revenue"));
    const sm = reqPos("prior_quarter_sm_spend", toDec("prior_quarter_sm_spend", need(p, "prior_quarter_sm_spend")));
    const value = cur.minus(prior).times(4).div(sm);
    const verdict = value.gte("0.75") ? "efficient (>=0.75)" : value.gte("0.5") ? "acceptable (>=0.5)" : "inefficient (<0.5)";
    return ok({ value, formatted_value: `${quantize(value).toFixed(2)}`, formula: "magic_number = ((current_quarter_revenue - prior_quarter_revenue) * 4) / prior_quarter_sm_spend", inputs_used: { current_quarter_revenue: cur, prior_quarter_revenue: prior, prior_quarter_sm_spend: sm }, unit: "ratio", notes: [`Interpretation: ${verdict}.`, "Annualizes the quarter-over-quarter revenue gain (x4)."] });
  },
};

export function calculate_metric({ metric, params, currency = "USD" }) {
  const key = String(metric || "").trim().toLowerCase();
  if (!METRICS[key]) throw new CalcError(`Unknown metric '${metric}'.`, { hint: `Supported: ${Object.keys(METRICS).sort().join(", ")}. Call list_metrics for schemas.`, type: "unknown_metric" });
  if (typeof params !== "object" || params === null) throw new CalcError("params must be an object of named numeric parameters.", { hint: 'Example: {"arpu": 100, "churn_rate": 0.05}' });
  return METRICS[key](params, String(currency || "USD").toUpperCase());
}
export function list_metrics() {
  return { status: "success", count: Object.keys(METRIC_CATALOG).length, metrics: METRIC_CATALOG, notes: ["Rates and margins are decimals (0.05 = 5%).", "All monetary results use exact Decimal arithmetic."] };
}

// ===========================================================================
// CURRENCY (static table + live frankfurter via fetch)
// ===========================================================================
const RATES_AS_OF = "2024-06-01T00:00:00Z";
const USD_RATES = { USD: D(1), EUR: D("0.9200"), GBP: D("0.7850"), JPY: D("157.00"), CAD: D("1.3700"), AUD: D("1.5050"), CHF: D("0.8950"), CNY: D("7.2400"), INR: D("83.50") };
export const SUPPORTED_CURRENCIES = Object.keys(USD_RATES);
const _fxCache = new Map();

function ensureCurrency(code) {
  if (!USD_RATES[code]) throw new CalcError(`Unsupported currency '${code}'.`, { hint: `Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`, type: "unsupported_currency" });
}
function validDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new CalcError(`Invalid date '${v}'. Expected YYYY-MM-DD.`, { hint: "Example: 2024-01-15." });
  const d = new Date(v + "T00:00:00Z"); if (isNaN(d)) throw new CalcError(`Invalid date '${v}'.`);
  if (d > new Date()) throw new CalcError(`Date '${v}' is in the future; no rate exists yet.`, { hint: "Use today's date or a past date." });
  return v;
}
async function fetchLiveRates(dateKey) {
  const cached = _fxCache.get(dateKey);
  if (cached && Date.now() - cached.t < 3600_000) return cached;
  const symbols = SUPPORTED_CURRENCIES.filter((c) => c !== "USD").join(",");
  const url = `https://api.frankfurter.app/${dateKey}?from=USD&to=${symbols}`;
  const resp = await fetch(url, { headers: { "User-Agent": "PrecisionCalc/2.0" } });
  if (!resp.ok) throw new CalcError(`Live FX lookup failed: HTTP ${resp.status}`, { type: "fx_provider_error" });
  const payload = await resp.json();
  const rates = { USD: D(1) };
  for (const c of SUPPORTED_CURRENCIES) if (c !== "USD" && payload.rates?.[c] != null) rates[c] = D(payload.rates[c]);
  const out = { rates, as_of: `${payload.date || dateKey} (ECB via frankfurter.app)`, t: Date.now() };
  _fxCache.set(dateKey, out);
  return out;
}

export async function currency_convert({ amount, from_currency, to_currency, date = null, live = null }) {
  const amt = reqNonNeg("amount", toDec("amount", amount));
  const src = String(from_currency || "").toUpperCase();
  const dst = String(to_currency || "").toUpperCase();
  ensureCurrency(src); ensureCurrency(dst);
  const parsed = date ? validDate(date) : null;
  const notes = [];
  const useLive = live === true ? true : live === false ? false : !!date;
  let rates = USD_RATES, asOf = RATES_AS_OF, provider = "static", isLive = false;
  if (useLive) {
    try {
      const r = await fetchLiveRates(parsed || "latest");
      rates = r.rates; asOf = r.as_of; provider = "frankfurter"; isLive = true;
      if (!rates[src] || !rates[dst]) throw new CalcError("Live provider missing a requested currency.", { type: "fx_provider_error" });
    } catch (e) {
      rates = USD_RATES; asOf = RATES_AS_OF; provider = "static (fallback)"; isLive = false;
      notes.push(`Live FX unavailable (${e.message}); used static mid-market table instead.`);
      if (parsed) notes.push(`Requested historical date '${date}' could not be honored; static rate applied.`);
    }
  }
  const rate = rates[dst].div(rates[src]);
  const converted = amt.times(rate);
  const places = ZERO_DECIMAL.has(dst) ? 0 : 2;
  const q = quantize(converted, places);
  notes.push("Cross rate computed via USD base: rate = usd_per[to] / usd_per[from].");
  notes.push(provider.startsWith("static") ? "Static rates are indicative for MVP; not for settlement/trading."
    : "Live ECB reference rates (frankfurter.app); indicative, not for settlement.");
  return ok({
    value: converted, formatted_value: fmtMoney(q, dst, places),
    formula: "converted = amount * (usd_per[to] / usd_per[from])",
    inputs_used: { amount: amt, from_currency: src, to_currency: dst, requested_date: date, live: useLive },
    unit: dst, notes,
    extra: { rate, rate_formatted: `1 ${src} = ${rate.toDecimalPlaces(8)} ${dst}`, rate_as_of: asOf, provider, is_live: isLive, retrieved_at: new Date().toISOString(), rounded_value: q },
  });
}

// ===========================================================================
// BUSINESS DAYS
// ===========================================================================
const SUPPORTED_REGIONS = ["US", "UK", "EU", "NONE"];
function ymd(d) { return d.toISOString().slice(0, 10); }
function parseDate(v, field = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new CalcError(`Invalid ${field} '${v}'. Expected YYYY-MM-DD.`, { hint: "Example: 2024-12-24." });
  const d = new Date(String(v) + "T00:00:00Z"); if (isNaN(d)) throw new CalcError(`Invalid ${field} '${v}'.`);
  return d;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function dow(d) { return d.getUTCDay(); } // 0=Sun..6=Sat
function isWeekend(d) { return dow(d) === 0 || dow(d) === 6; }
function nthWeekday(year, month, weekday, n) { // month 1-12, weekday 0=Mon..6=Sun (python style)
  const jsW = (weekday + 1) % 7; // convert Mon0 -> JS Sun0
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (jsW - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
  }
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - jsW + 7) % 7;
  return new Date(Date.UTC(year, month, 0 - offset));
}
function observed(d) { const w = dow(d); if (w === 6) return addDays(d, -1); if (w === 0) return addDays(d, 1); return d; }
function easterSunday(year) { // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, dd = Math.floor(b / 4), e = b % 4,
    f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function usHolidays(year) {
  return new Set([
    observed(new Date(Date.UTC(year, 0, 1))), nthWeekday(year, 1, 0, 3), nthWeekday(year, 2, 0, 3),
    nthWeekday(year, 5, 0, -1), observed(new Date(Date.UTC(year, 5, 19))), observed(new Date(Date.UTC(year, 6, 4))),
    nthWeekday(year, 9, 0, 1), nthWeekday(year, 10, 0, 2), observed(new Date(Date.UTC(year, 10, 11))),
    nthWeekday(year, 11, 3, 4), observed(new Date(Date.UTC(year, 11, 25))),
  ].map(ymd));
}
function ukObserved(d) { while (isWeekend(d)) d = addDays(d, 1); return d; }
function ukHolidays(year) {
  const es = easterSunday(year);
  return new Set([
    ukObserved(new Date(Date.UTC(year, 0, 1))), addDays(es, -2), addDays(es, 1),
    nthWeekday(year, 5, 0, 1), nthWeekday(year, 5, 0, -1), nthWeekday(year, 8, 0, -1),
    ukObserved(new Date(Date.UTC(year, 11, 25))), ukObserved(new Date(Date.UTC(year, 11, 26))),
  ].map(ymd));
}
function euHolidays(year) {
  const es = easterSunday(year);
  return new Set([
    new Date(Date.UTC(year, 0, 1)), addDays(es, -2), addDays(es, 1),
    new Date(Date.UTC(year, 4, 1)), new Date(Date.UTC(year, 11, 25)), new Date(Date.UTC(year, 11, 26)),
  ].map(ymd));
}
const REGION_FUNCS = { US: usHolidays, UK: ukHolidays, EU: euHolidays };
function holidaysFor(region, years, custom) {
  region = String(region || "US").toUpperCase();
  if (!SUPPORTED_REGIONS.includes(region))
    throw new CalcError(`Unsupported region '${region}'.`, { hint: `Supported regions: ${SUPPORTED_REGIONS.join(", ")}. (Hosted edge build supports US/UK/EU/NONE + custom holidays.)`, type: "unsupported_region" });
  const set = new Set();
  if (region !== "NONE") for (const y of years) for (const h of REGION_FUNCS[region](y)) set.add(h);
  for (const iso of custom || []) set.add(ymd(parseDate(iso, "custom_holidays entry")));
  return set;
}
function isBusinessDay(d, hol) { return !isWeekend(d) && !hol.has(ymd(d)); }

export function business_days({ operation, start_date, days = null, end_date = null, region = "US", custom_holidays = null }) {
  const op = String(operation || "").trim().toLowerCase();
  const start = parseDate(start_date, "start_date");
  const R = String(region || "US").toUpperCase();
  if (op === "add_business_days") {
    if (days == null) throw new CalcError("add_business_days requires 'days'.", { hint: "Pass an integer 'days' (negative moves backwards)." });
    const n = parseInt(days, 10);
    const hol = holidaysFor(R, range(start.getUTCFullYear() - 1, start.getUTCFullYear() + 3), custom_holidays);
    let d = start, rem = Math.abs(n), step = n >= 0 ? 1 : -1;
    while (rem > 0) { d = addDays(d, step); if (isBusinessDay(d, hol)) rem--; }
    return ok({ value: ymd(d), formatted_value: humanDate(d), formula: "result = start_date shifted by N business days (skip weekends+holidays)", inputs_used: { start_date: ymd(start), days: n, region: R, custom_holidays: custom_holidays || [] }, unit: "date", notes: [`Weekends and ${R} holidays skipped.`, n < 0 ? "Negative 'days' moves backwards." : "Forward shift."] });
  }
  if (op === "count_business_days") {
    if (end_date == null) throw new CalcError("count_business_days requires 'end_date'.", { hint: "Pass 'end_date' in YYYY-MM-DD." });
    const end = parseDate(end_date, "end_date");
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    const hol = holidaysFor(R, range(lo.getUTCFullYear() - 1, hi.getUTCFullYear() + 2), custom_holidays);
    let count = 0, d = lo; while (d <= hi) { if (isBusinessDay(d, hol)) count++; d = addDays(d, 1); }
    return ok({ value: count, formatted_value: `${count} business day(s)`, formula: "count of business days in [min(start,end), max(start,end)] inclusive", inputs_used: { start_date: ymd(start), end_date: ymd(end), region: R, custom_holidays: custom_holidays || [] }, unit: "days", notes: [`Inclusive range ${ymd(lo)} .. ${ymd(hi)}.`, `Weekends and ${R} holidays excluded.`] });
  }
  if (op === "next_business_day" || op === "previous_business_day") {
    const step = op === "next_business_day" ? 1 : -1;
    const hol = holidaysFor(R, range(start.getUTCFullYear() - 1, start.getUTCFullYear() + 2), custom_holidays);
    let d = addDays(start, step); while (!isBusinessDay(d, hol)) d = addDays(d, step);
    return ok({ value: ymd(d), formatted_value: humanDate(d), formula: `first business day ${step > 0 ? "after" : "before"} start_date`, inputs_used: { start_date: ymd(start), region: R, custom_holidays: custom_holidays || [] }, unit: "date", notes: [`Weekends and ${R} holidays skipped.`] });
  }
  throw new CalcError(`Unknown operation '${operation}'.`, { hint: "Use add_business_days | count_business_days | next_business_day | previous_business_day.", type: "unknown_operation" });
}
function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function humanDate(d) { return `${WD[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }

// ===========================================================================
// COMPOUND GROWTH
// ===========================================================================
const FREqs = { daily: D(365), weekly: D(52), monthly: D(12), quarterly: D(4), semiannually: D(2), annually: D(1) };
function growthFactor(rate, years, freq) {
  if (freq === "continuous") return { factor: rate.times(years).exp(), ff: "e^(r*t)" };
  const n = FREqs[freq];
  if (!n) throw new CalcError(`Unsupported compounding frequency '${freq}'.`, { hint: `Use: ${Object.keys(FREqs).join(", ")}, continuous.`, type: "unsupported_frequency" });
  const base = D(1).plus(rate.div(n));
  if (base.lte(0)) throw new CalcError("Effective period rate <= -100%; growth factor undefined.", { hint: "Check rate and compounding frequency." });
  return { factor: base.pow(n.times(years)), ff: "(1 + r/n)^(n*t)" };
}
export function compound_growth({ operation, rate = null, years = null, present_value = null, future_value = null, begin_value = null, end_value = null, compounding = "annually", currency = "USD" }) {
  const op = String(operation || "").trim().toLowerCase();
  const cur = String(currency || "USD").toUpperCase();
  const freq = String(compounding || "annually").trim().toLowerCase();
  if (op === "future_value") {
    const r = toDec("rate", rate), t = reqPos("years", toDec("years", years)), pv = toDec("present_value", present_value);
    const { factor, ff } = growthFactor(r, t, freq); const fv = pv.times(factor);
    return ok({ value: fv, formatted_value: fmtMoney(fv, cur), formula: `FV = PV * ${ff}   (r=annual rate, n=periods/yr, t=years)`, inputs_used: { present_value: pv, rate: r, years: t, compounding: freq }, unit: cur, notes: [`Growth factor = ${factor.toDecimalPlaces(8)}.`, "rate is a decimal (0.08 = 8%)."], extra: { growth_factor: factor, rounded_value: quantize(fv) } });
  }
  if (op === "present_value") {
    const r = toDec("rate", rate), t = reqPos("years", toDec("years", years)), fv = toDec("future_value", future_value);
    const { factor, ff } = growthFactor(r, t, freq); const pv = fv.div(factor);
    return ok({ value: pv, formatted_value: fmtMoney(pv, cur), formula: `PV = FV / ${ff}   (r=annual rate, n=periods/yr, t=years)`, inputs_used: { future_value: fv, rate: r, years: t, compounding: freq }, unit: cur, notes: [`Discount factor = ${factor.toDecimalPlaces(8)}.`, "rate is a decimal (0.08 = 8%)."], extra: { discount_factor: factor, rounded_value: quantize(pv) } });
  }
  if (op === "cagr") {
    const b = reqPos("begin_value", toDec("begin_value", begin_value)), e = reqPos("end_value", toDec("end_value", end_value)), t = reqPos("years", toDec("years", years));
    const cagr = e.div(b).pow(D(1).div(t)).minus(1);
    return ok({ value: cagr, formatted_value: fmtPercent(cagr), formula: "CAGR = (end_value / begin_value)^(1/years) - 1", inputs_used: { begin_value: b, end_value: e, years: t }, unit: "percent", notes: ["Value is a ratio (0.15 = 15% annualized)."] });
  }
  throw new CalcError(`Unknown operation '${operation}'.`, { hint: "Use future_value | present_value | cagr.", type: "unknown_operation" });
}

// ===========================================================================
// FINANCE: NPV / IRR / loan / depreciation
// ===========================================================================
function coerceFlows(cf) {
  if (!Array.isArray(cf) || cf.length < 2) throw new CalcError("cashflows must be a list of at least 2 numbers (e.g. [-1000, 300, 400, 500]).", { hint: "Index 0 is period 0 (typically the negative initial investment)." });
  return cf.map((v, i) => toDec(`cashflows[${i}]`, v));
}
function npv(rate, flows) { let t = D(0); flows.forEach((cf, i) => { t = t.plus(cf.div(D(1).plus(rate).pow(i))); }); return t; }
function npvDeriv(rate, flows) { let d = D(0); flows.forEach((cf, i) => { if (i) d = d.plus(cf.times(-i).div(D(1).plus(rate).pow(i + 1))); }); return d; }

export function net_present_value({ rate, cashflows, currency = "USD" }) {
  const r = toDec("rate", rate);
  if (r.lte(-1)) throw new CalcError("rate must be greater than -100% (-1).", { hint: "Use e.g. 0.08 for 8%." });
  const flows = coerceFlows(cashflows); const value = npv(r, flows); const cur = String(currency || "USD").toUpperCase();
  return ok({ value, formatted_value: fmtMoney(value, cur), formula: "NPV = sum(CF_t / (1 + rate)^t) for t = 0..n", inputs_used: { rate: r, cashflows: flows.map(normStr) }, unit: cur, notes: ["Period 0 cashflow is not discounted.", "Positive NPV => value-creating at this discount rate."], extra: { rounded_value: quantize(value), periods: flows.length - 1 } });
}
export function internal_rate_of_return({ cashflows, guess = 0.1 }) {
  const flows = coerceFlows(cashflows);
  const min = flows.reduce((a, b) => (a.lt(b) ? a : b)), max = flows.reduce((a, b) => (a.gt(b) ? a : b));
  if (!(min.lt(0) && max.gt(0))) throw new CalcError("IRR requires at least one negative and one positive cashflow.", { hint: "Typically CF_0 is negative (investment) and later flows positive." });
  let rate = newton(flows, toDec("guess", guess)); if (rate == null) rate = bisection(flows);
  if (rate == null) throw new CalcError("IRR did not converge for the provided cashflows.", { hint: "Cashflows may have multiple/no sign changes.", type: "no_convergence" });
  const check = npv(rate, flows);
  return ok({ value: rate, formatted_value: fmtPercent(rate), formula: "IRR solves NPV(rate) = sum(CF_t / (1 + rate)^t) = 0", inputs_used: { cashflows: flows.map(normStr), guess: toDec("guess", guess) }, unit: "percent", notes: [`NPV at solved IRR ~= ${check.toDecimalPlaces(6)} (should be ~0).`, "Per-period rate; annualize if periods are not years."] });
}
function newton(flows, guess) {
  let rate = guess; const tol = D("1e-12");
  for (let i = 0; i < 100; i++) {
    if (rate.lte(-1)) return null;
    const f = npv(rate, flows); if (f.abs().lt(tol)) return rate;
    const d = npvDeriv(rate, flows); if (d.isZero()) return null;
    const step = f.div(d); rate = rate.minus(step);
    if (step.abs().lt(tol)) return npv(rate, flows).abs().lt(D("1e-6")) ? rate : null;
  }
  return null;
}
function bisection(flows) {
  let lo = D("-0.999999"), hi = D(100), flo = npv(lo, flows), fhi = npv(hi, flows);
  if (flo.times(fhi).gt(0)) return null;
  for (let i = 0; i < 400; i++) {
    const mid = lo.plus(hi).div(2), fmid = npv(mid, flows);
    if (fmid.abs().lt(D("1e-12"))) return mid;
    if (flo.times(fmid).lt(0)) { hi = mid; fhi = fmid; } else { lo = mid; flo = fmid; }
  }
  return lo.plus(hi).div(2);
}
export function loan_amortization({ principal, annual_rate, term_months, extra_payment = 0, currency = "USD", include_schedule = false }) {
  const p = reqPos("principal", toDec("principal", principal));
  const ar = reqNonNeg("annual_rate", toDec("annual_rate", annual_rate));
  const n = parseInt(reqPos("term_months", toDec("term_months", term_months)).toString(), 10);
  const extra = reqNonNeg("extra_payment", toDec("extra_payment", extra_payment));
  const cur = String(currency || "USD").toUpperCase();
  const r = ar.div(12);
  let payment = r.isZero() ? p.div(n) : p.times(r).div(D(1).minus(D(1).plus(r).pow(-n)));
  const paymentQ = quantize(payment);
  let balance = p, totalInterest = D(0), month = 0; const schedule = [];
  while (balance.gt("0.005") && month < n + 1200) {
    month++;
    const interest = quantize(balance.times(r));
    let principalPaid = paymentQ.minus(interest).plus(extra); let actual;
    if (principalPaid.gte(balance) || balance.minus(principalPaid).lte("0.01") || month >= n) {
      principalPaid = balance; actual = quantize(balance.plus(interest));
    } else actual = quantize(paymentQ.plus(extra));
    balance = quantize(balance.minus(principalPaid)); totalInterest = totalInterest.plus(interest);
    if (include_schedule && schedule.length < 1200) schedule.push({ month: String(month), payment: actual.toFixed(2), interest: interest.toFixed(2), principal: quantize(principalPaid).toFixed(2), balance: balance.toFixed(2) });
    if (balance.lte("0.005")) break;
  }
  const totalPaid = quantize(p.plus(totalInterest));
  const notes = ["Monthly payment uses the standard amortization formula.", "Interest each month = outstanding balance x (annual_rate / 12)."];
  if (extra.gt(0)) notes.push(`Extra principal of ${fmtMoney(extra, cur)}/mo shortens the term to ${month} months.`);
  const extraOut = { monthly_payment: paymentQ.toFixed(2), months_to_payoff: month, total_interest: quantize(totalInterest).toFixed(2), total_paid: totalPaid.toFixed(2) };
  if (include_schedule) extraOut.schedule = schedule;
  return ok({ value: paymentQ, formatted_value: `${fmtMoney(paymentQ, cur)}/month`, formula: "payment = P * r / (1 - (1 + r)^-n),  r = annual_rate/12,  n = term_months", inputs_used: { principal: p, annual_rate: ar, term_months: n, extra_payment: extra }, unit: `${cur}/month`, notes, extra: extraOut });
}
export function depreciation({ method, cost, salvage_value, useful_life_years, currency = "USD" }) {
  const m = String(method || "").trim().toLowerCase();
  const c = reqPos("cost", toDec("cost", cost));
  const s = reqNonNeg("salvage_value", toDec("salvage_value", salvage_value));
  const life = parseInt(reqPos("useful_life_years", toDec("useful_life_years", useful_life_years)).toString(), 10);
  const cur = String(currency || "USD").toUpperCase();
  if (s.gt(c)) throw new CalcError("salvage_value cannot exceed cost.", { hint: "Set salvage_value <= cost." });
  const depreciable = c.minus(s); const schedule = []; let book = c, formula, firstYear;
  if (m === "straight_line") {
    const annual = depreciable.div(life); formula = "annual = (cost - salvage) / useful_life_years";
    for (let yr = 1; yr <= life; yr++) { let dep = yr < life ? quantize(annual) : quantize(book.minus(s)); book = quantize(book.minus(dep)); schedule.push(depRow(yr, dep, book)); }
    firstYear = quantize(annual);
  } else if (m === "declining_balance") {
    const rate = D(2).div(life); formula = "dep_t = book_value_t * (2 / useful_life_years), floored at salvage";
    for (let yr = 1; yr <= life; yr++) { let dep = quantize(book.times(rate)); if (book.minus(dep).lt(s)) dep = quantize(book.minus(s)); book = quantize(book.minus(dep)); schedule.push(depRow(yr, dep, book)); }
    firstYear = D(schedule[0]?.depreciation || "0");
  } else if (m === "sum_of_years_digits") {
    const syd = D(life * (life + 1)).div(2); formula = "dep_t = (remaining_life / sum_of_years_digits) * (cost - salvage)";
    for (let yr = 1; yr <= life; yr++) { let dep = quantize(D(life - yr + 1).div(syd).times(depreciable)); if (yr === life) dep = quantize(book.minus(s)); book = quantize(book.minus(dep)); schedule.push(depRow(yr, dep, book)); }
    firstYear = D(schedule[0]?.depreciation || "0");
  } else throw new CalcError(`Unknown depreciation method '${method}'.`, { hint: "Use straight_line | declining_balance | sum_of_years_digits.", type: "unknown_method" });
  return ok({ value: firstYear, formatted_value: `Year 1 depreciation: ${fmtMoney(firstYear, cur)}`, formula, inputs_used: { method: m, cost: c, salvage_value: s, useful_life_years: life }, unit: cur, notes: [`Total depreciable base = ${fmtMoney(depreciable, cur)}.`, "Final year adjusted so ending book value equals salvage."], extra: { schedule, total_depreciated: quantize(depreciable) } });
}
function depRow(year, dep, book) { return { year: String(year), depreciation: dep.toFixed(2), book_value: book.toFixed(2) }; }

export function health_check() {
  return {
    status: "ok", server: "PrecisionCalc", version: "2.1.0-edge",
    precision: "decimal.js (50 significant digits)",
    tools: ["business_days", "batch_calculate", "calculate_metric", "compound_growth", "currency_convert", "depreciation", "health_check", "internal_rate_of_return", "list_metrics", "loan_amortization", "net_present_value"],
    supported_metrics: Object.keys(METRIC_CATALOG).sort(),
    supported_currencies: SUPPORTED_CURRENCIES,
    fx_provider: "static+frankfurter(live)",
    supported_regions: SUPPORTED_REGIONS,
    runtime: "cloudflare-pages-functions",
  };
}
