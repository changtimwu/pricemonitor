/**
 * Apple Taiwan Refurbished Store Tracker — multi-subscriber POC.
 *
 * Anyone can submit (email, keywords, max price) via GET /. The cron job
 * fetches the refurb store every 30 minutes and emails each subscriber
 * the items matching their personal spec, exactly once.
 *
 * Bindings:
 *   - SEEN_PRODUCTS   : KV namespace  (stores sub:<uuid> records)
 *   - RESEND_API_KEY  : Secret        (https://resend.com)
 */

export interface Env {
  SEEN_PRODUCTS: KVNamespace;
  RESEND_API_KEY: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
  url: string;
}

interface Subscription {
  id: string;
  email: string;
  keywords: string[];
  maxPrice: number; // 0 = no cap
  createdAt: string;
  seenIds: string[];
}

// Apple embeds product data as schema.org JSON-LD blocks in the HTML page.
interface LdOffer {
  "@type": "Offer";
  price?: number;
  priceCurrency?: string;
  sku?: string;
}

interface LdProduct {
  "@context": "https://schema.org";
  "@type": "Product";
  name?: string;
  url?: string;
  offers?: LdOffer | LdOffer[];
}

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const APPLE_REFURB_URL = "https://www.apple.com/tw/shop/refurbished/mac";

const FETCH_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
};

// Resend's testing sender works without DNS setup. Swap to a verified
// from-address once you've added your own domain in the Resend dashboard.
const EMAIL_FROM = "Apple Refurb Tracker <onboarding@resend.dev>";

const SUB_PREFIX = "sub:";

// ─────────────────────────────────────────────
//  FETCH PRODUCTS
// ─────────────────────────────────────────────

const LD_JSON_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

async function fetchRefurbProducts(): Promise<Product[]> {
  const resp = await fetch(APPLE_REFURB_URL, { headers: FETCH_HEADERS });
  if (!resp.ok) throw new Error(`Apple page error: ${resp.status}`);

  const html = await resp.text();
  const out: Product[] = [];

  for (const match of html.matchAll(LD_JSON_RE)) {
    const blob = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as LdProduct)["@type"] !== "Product"
    ) {
      continue;
    }
    const p = parsed as LdProduct;
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const id = offer?.sku || "";
    const name = p.name || "";
    if (!id || !name) continue;
    out.push({
      id,
      name,
      price: Number(offer?.price) || 0,
      url: p.url || APPLE_REFURB_URL,
    });
  }
  return out;
}

// Apple TW writes "MacBook Pro" with non-breaking spaces (and around
// numerals like "12 核心"). User keywords use normal spaces, so we
// collapse all whitespace to a single ASCII space on both sides.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function matches(product: Product, sub: Subscription): boolean {
  const name = normalize(product.name);
  const matched = sub.keywords.some((kw) => name.includes(normalize(kw)));
  if (!matched) return false;
  if (sub.maxPrice && product.price && product.price > sub.maxPrice)
    return false;
  return true;
}

// ─────────────────────────────────────────────
//  EMAIL NOTIFY (Resend)
// ─────────────────────────────────────────────

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Resend failed for ${to}: ${resp.status} ${body}`);
  } else {
    console.log(`Email sent to ${to} ✓`);
  }
}

// ─────────────────────────────────────────────
//  KV HELPERS  (one record per subscriber)
// ─────────────────────────────────────────────

async function listSubs(kv: KVNamespace): Promise<Subscription[]> {
  const out: Subscription[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: SUB_PREFIX, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as Subscription);
      } catch {
        console.error(`Bad sub JSON at ${k.name}`);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function saveSub(kv: KVNamespace, sub: Subscription): Promise<void> {
  await kv.put(SUB_PREFIX + sub.id, JSON.stringify(sub));
}

async function deleteSub(kv: KVNamespace, id: string): Promise<boolean> {
  const key = SUB_PREFIX + id;
  const existed = (await kv.get(key)) !== null;
  if (existed) await kv.delete(key);
  return existed;
}

// ─────────────────────────────────────────────
//  CHECK ALL SUBSCRIBERS
// ─────────────────────────────────────────────

async function checkAllSubs(env: Env, origin: string): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running check for all subs...`);

  const products = await fetchRefurbProducts();
  console.log(`Fetched ${products.length} products`);

  const subs = await listSubs(env.SEEN_PRODUCTS);
  console.log(`Loaded ${subs.length} subscriber(s)`);

  for (const sub of subs) {
    const seen = new Set(sub.seenIds);
    const newForSub: Product[] = [];
    for (const p of products) {
      if (!matches(p, sub)) continue;
      if (seen.has(p.id)) continue;
      newForSub.push(p);
      seen.add(p.id);
    }
    if (newForSub.length === 0) {
      console.log(`  ${sub.email}: no new matches`);
      continue;
    }
    console.log(`  ${sub.email}: ${newForSub.length} new match(es)`);
    const body =
      newForSub
        .map(
          (item) =>
            `產品：${item.name}\n` +
            `價格：${item.price ? `NT$ ${item.price.toLocaleString()}` : "價格未知"}\n` +
            `連結：${item.url}\n`
        )
        .join("\n") +
      `\n---\n取消訂閱 / Unsubscribe: ${origin}/unsubscribe/${sub.id}\n`;
    const subject = `🖥️ Apple 整修品上架通知 (${newForSub.length})`;
    await sendEmail(env.RESEND_API_KEY, sub.email, subject, body);
    sub.seenIds = [...seen];
    await saveSub(env.SEEN_PRODUCTS, sub);
  }
}

// ─────────────────────────────────────────────
//  HTTP — HTML helpers
// ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const PAGE_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 560px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;
         color: #222; }
  h1 { font-size: 1.5rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box;
          border: 1px solid #ccc; border-radius: 6px; }
  small { color: #666; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font-size: 1rem;
           background: #0070c9; color: #fff; border: 0; border-radius: 6px;
           cursor: pointer; }
  .ok { background: #e8f5e9; padding: 1rem; border-radius: 6px; }
  .err { background: #ffebee; padding: 1rem; border-radius: 6px; }
  code { background: #f4f4f4; padding: 0 0.25rem; border-radius: 3px; }
`;

function homePage(): string {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>Apple 整修品追蹤</title><style>${PAGE_CSS}</style></head><body>
<h1>🖥️ Apple Refurb Tracker</h1>
<p>每 30 分鐘檢查 Apple 台灣整修品商店，新上架且符合你關鍵字的商品會寄到你的信箱。</p>
<div class="err">
<strong>⚠️ POC limitation</strong> — this demo sends from Resend's testing
sender, which only delivers to the operator's own inbox. Subscribing other
addresses will save the form, but the email will silently fail until a
custom domain is verified in Resend.
</div>
<form method="post" action="/subscribe">
  <label>Email
    <input type="email" name="email" required placeholder="you@example.com">
  </label>
  <label>關鍵字 Keywords <small>(逗號分隔，OR 比對，例：<code>Mac Studio, Mac Mini</code>)</small>
    <input type="text" name="keywords" required placeholder="Mac Studio, Mac Mini">
  </label>
  <label>價格上限 Max price NT$ <small>(留空 = 不限)</small>
    <input type="number" name="maxPrice" min="0" placeholder="80000">
  </label>
  <button type="submit">訂閱 Subscribe</button>
</form>
<p><small>POC — no signup, no login. Anyone with the unsubscribe link in the
email can opt out.</small></p>
</body></html>`;
}

function thanksPage(sub: Subscription, origin: string): string {
  const kw = sub.keywords.map(escapeHtml).join(", ");
  const cap = sub.maxPrice
    ? `NT$ ${sub.maxPrice.toLocaleString()}`
    : "不限 / no cap";
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>已訂閱</title><style>${PAGE_CSS}</style></head><body>
<h1>✅ 訂閱成功 / Subscribed</h1>
<div class="ok">
<p>Email: <code>${escapeHtml(sub.email)}</code></p>
<p>關鍵字: <code>${kw}</code></p>
<p>價格上限: <code>${cap}</code></p>
</div>
<p>取消訂閱 / Unsubscribe: <a href="${origin}/unsubscribe/${sub.id}">${origin}/unsubscribe/${sub.id}</a></p>
<p><a href="/">← back</a></p>
</body></html>`;
}

function errorPage(msg: string): string {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>Error</title><style>${PAGE_CSS}</style></head><body>
<h1>❌ Error</h1><div class="err">${escapeHtml(msg)}</div>
<p><a href="/">← back</a></p></body></html>`;
}

function unsubbedPage(found: boolean): string {
  return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>已取消訂閱</title><style>${PAGE_CSS}</style></head><body>
<h1>${found ? "👋 已取消訂閱 / Unsubscribed" : "🤔 找不到此訂閱"}</h1>
<p><a href="/">← back</a></p></body></html>`;
}

// ─────────────────────────────────────────────
//  HTTP HANDLERS
// ─────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleSubscribe(
  request: Request,
  env: Env,
  origin: string
): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const rawKw = String(form.get("keywords") || "");
  const rawCap = String(form.get("maxPrice") || "").trim();

  if (!EMAIL_RE.test(email)) {
    return htmlResponse(errorPage("Invalid email address."), 400);
  }
  const keywords = rawKw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60);
  if (keywords.length === 0) {
    return htmlResponse(errorPage("Provide at least one keyword."), 400);
  }
  const maxPrice = rawCap === "" ? 0 : Math.max(0, Math.floor(Number(rawCap) || 0));

  const sub: Subscription = {
    id: crypto.randomUUID(),
    email,
    keywords,
    maxPrice,
    createdAt: new Date().toISOString(),
    seenIds: [],
  };
  await saveSub(env.SEEN_PRODUCTS, sub);
  console.log(`New sub ${sub.id} ${email} keywords=${keywords.join("|")} cap=${maxPrice}`);
  return htmlResponse(thanksPage(sub, origin));
}

async function handleUnsubscribe(env: Env, id: string): Promise<Response> {
  const found = await deleteSub(env.SEEN_PRODUCTS, id);
  console.log(`Unsubscribe ${id} found=${found}`);
  return htmlResponse(unsubbedPage(found), found ? 200 : 404);
}

// ─────────────────────────────────────────────
//  CLOUDFLARE WORKER ENTRY POINTS
// ─────────────────────────────────────────────

export default {
  // Note: scheduled has no Request, so we can't derive origin. Use the
  // Worker's public hostname directly — this is only used in unsub links
  // in emails. Override via setting `PUBLIC_ORIGIN` env var if needed.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const origin = "https://apple-refurb-tracker.changtimwu.workers.dev";
    ctx.waitUntil(checkAllSubs(env, origin));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return htmlResponse(homePage());
      }
      if (url.pathname === "/subscribe" && request.method === "POST") {
        return handleSubscribe(request, env, origin);
      }
      if (url.pathname.startsWith("/unsubscribe/") && request.method === "GET") {
        const id = url.pathname.slice("/unsubscribe/".length);
        return handleUnsubscribe(env, id);
      }
      if (url.pathname === "/run" && request.method === "GET") {
        await checkAllSubs(env, origin);
        return new Response("✅ Checked all subs. See Worker logs.", {
          status: 200,
        });
      }
      return htmlResponse(errorPage("Not found."), 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      return htmlResponse(errorPage(msg), 500);
    }
  },
} satisfies ExportedHandler<Env>;
