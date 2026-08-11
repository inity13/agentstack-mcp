// Billing + metering for the hosted AgentStack MCP suite.
// - One API key + one daily quota spans ALL three products + composites.
// - API keys + usage counters live in Cloudflare KV (env.AGENTSTACK_KV).
// - Payments via Stripe Checkout (subscription).
// Never logs or returns the Stripe secret.
//
// Mirrors the per-product billing 1:1, but the value proposition is one key /
// one plan for the whole stack (cheaper than buying the three separately).
//
// SELF-HOST / PRIVATE MODE: leave KV + Stripe unset and the server fails open
// (free tier, quota disabled). The engines are pure and need none of it.

const STRIPE = "https://api.stripe.com/v1";
const SV = "2024-06-20"; // pinned Stripe API version (account requires it)

async function stripe(env, method, path, params) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": SV };
  let body;
  if (params) { body = new URLSearchParams(params).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  const r = await fetch(STRIPE + path, { method, headers, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path} ${r.status}: ${j.error?.message || "error"}`);
  return j;
}

// ---- plan config ------------------------------------------------------------
// NOTE (rate limiting): daily KV counter. Swap for a token-bucket / sliding
// window in a Durable Object or Redis if you need per-minute limits.
export function planLimits(env) {
  return {
    free: parseInt(env.FREE_DAILY || "20", 10),
    starter: parseInt(env.STARTER_DAILY || "8000", 10),
    pro: parseInt(env.PRO_DAILY || "80000", 10),
  };
}
function priceFor(env, plan) { return plan === "pro" ? env.PRICE_PRO : env.PRICE_STARTER; }
function planForPrice(env, priceId) {
  if (priceId === env.PRICE_PRO) return "pro";
  if (priceId === env.PRICE_STARTER) return "starter";
  return null;
}

// ---- identity + quota -------------------------------------------------------
// NOTE (auth): keys via `X-API-Key` or `Authorization: Bearer <key>`. To add a
// different scheme (JWT, per-org keys), change extractKey + identify only.
function extractKey(request) {
  let k = request.headers.get("x-api-key");
  if (!k) { const a = request.headers.get("authorization") || ""; if (a.toLowerCase().startsWith("bearer ")) k = a.slice(7).trim(); }
  return k || null;
}

export async function identify(request, env) {
  const kv = env.AGENTSTACK_KV;
  const key = extractKey(request);
  if (key && kv) {
    const rec = await kv.get(`key:${key}`, "json");
    if (rec && rec.status === "active") return { plan: rec.plan, identity: `key:${key.slice(0, 12)}`, apiKey: key, active: true, customer: rec.customer };
    if (rec && rec.status !== "active") return { plan: "revoked", identity: `key:${key.slice(0, 12)}`, apiKey: key, active: false };
    return { plan: "invalid_key", identity: "invalid", apiKey: key, active: false };
  }
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  return { plan: "free", identity: `ip:${ip}`, apiKey: null, active: true };
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }

export async function consumeQuota(env, identity, limit) {
  const kv = env.AGENTSTACK_KV;
  if (!kv) return { allowed: true, used: 0, limit, remaining: limit };
  const k = `usage:${identity}:${todayUTC()}`;
  const used = parseInt((await kv.get(k)) || "0", 10);
  if (used >= limit) return { allowed: false, used, limit, remaining: 0 };
  await kv.put(k, String(used + 1), { expirationTtl: 172800 });
  return { allowed: true, used: used + 1, limit, remaining: Math.max(0, limit - used - 1) };
}

// ---- upsell envelope --------------------------------------------------------
export function upsell(env, kind, ctx = {}) {
  const base = env.AGENTSTACK_BASE_URL || "https://agentstack-mcp.pages.dev";
  const L = planLimits(env);
  const messages = {
    quota_exceeded: `Free tier limit reached (${L.free} calls/day). Upgrade for the full stack.`,
    revoked: "This API key is inactive (subscription canceled or unpaid). Renew to continue.",
    invalid_key: "Invalid API key. Purchase a plan to receive a working key.",
    upgrade_required: "This tool requires a paid plan.",
  };
  return {
    status: "error",
    error: { type: kind, message: messages[kind] || "Upgrade required.", hint: "Buy a plan, then send your key as HTTP header 'X-API-Key: <key>'." },
    upgrade: {
      pricing_url: `${base}/#pricing`,
      note: "One key covers all three products (simulate + decide + compute) and the composite tools.",
      plans: [
        { name: "Starter", price: "$19/mo", daily_calls: L.starter, checkout_url: `${base}/checkout?plan=starter` },
        { name: "Pro", price: "$59/mo", daily_calls: L.pro, checkout_url: `${base}/checkout?plan=pro` },
      ],
    },
    usage: ctx.usage || null,
  };
}

// ---- checkout + provisioning ------------------------------------------------
export async function createCheckout(env, plan) {
  const price = priceFor(env, plan);
  if (!price) throw new Error("Unknown plan");
  const base = env.AGENTSTACK_BASE_URL;
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    allow_promotion_codes: "true",
    success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#pricing`,
    "metadata[app]": "agentstack",
    "metadata[plan]": plan,
    "subscription_data[metadata][app]": "agentstack",
    "subscription_data[metadata][plan]": plan,
  });
  return session.url;
}

function newKey() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ssak_live_${hex}`;
}

export async function provisionFromSession(env, sessionId) {
  const kv = env.AGENTSTACK_KV;
  const existing = await kv.get(`session:${sessionId}`);
  if (existing) {
    const rec = await kv.get(`key:${existing}`, "json");
    return { key: existing, plan: rec?.plan, reused: true };
  }
  const s = await stripe(env, "GET", `/checkout/sessions/${sessionId}?expand[]=subscription&expand[]=line_items`);
  if (s.payment_status !== "paid" && s.status !== "complete") throw new Error("Payment not completed for this session.");
  const priceId = s.line_items?.data?.[0]?.price?.id || (await stripe(env, "GET", `/checkout/sessions/${sessionId}/line_items`)).data?.[0]?.price?.id;
  const plan = planForPrice(env, priceId) || s.metadata?.plan || "starter";
  const subId = typeof s.subscription === "object" ? s.subscription?.id : s.subscription;
  const key = newKey();
  const rec = { plan, status: "active", customer: s.customer, subscription: subId, created: Date.now() };
  await kv.put(`key:${key}`, JSON.stringify(rec));
  if (subId) await kv.put(`sub:${subId}`, key);
  await kv.put(`session:${sessionId}`, key);
  return { key, plan, reused: false };
}

// ---- webhook ----------------------------------------------------------------
export async function verifyStripeSignature(env, payload, sigHeader) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export async function handleWebhookEvent(env, event) {
  const kv = env.AGENTSTACK_KV;
  const type = event.type;
  const obj = event.data?.object || {};
  if (type === "customer.subscription.deleted" || type === "customer.subscription.updated") {
    const subId = obj.id;
    const active = obj.status === "active" || obj.status === "trialing";
    const key = subId ? await kv.get(`sub:${subId}`) : null;
    if (key) {
      const rec = await kv.get(`key:${key}`, "json");
      if (rec) { rec.status = active ? "active" : "inactive"; await kv.put(`key:${key}`, JSON.stringify(rec)); }
    }
  }
  return true;
}

export async function createPortal(env, apiKey) {
  const kv = env.AGENTSTACK_KV;
  const rec = apiKey ? await kv.get(`key:${apiKey}`, "json") : null;
  if (!rec?.customer) throw new Error("Unknown key/customer.");
  const session = await stripe(env, "POST", "/billing_portal/sessions", { customer: rec.customer, return_url: `${env.AGENTSTACK_BASE_URL}/#pricing` });
  return session.url;
}
