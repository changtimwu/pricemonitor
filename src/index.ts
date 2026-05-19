/**
 * Apple Taiwan Refurbished Store Tracker
 * Runs on Cloudflare Workers via cron trigger (every 30 min).
 *
 * Environment bindings required (set in wrangler.toml / Cloudflare dashboard):
 *   - SEEN_PRODUCTS : KV namespace  (stores seen product IDs)
 *   - LINE_NOTIFY_TOKEN : Secret    (your LINE Notify token)
 */

export interface Env {
  SEEN_PRODUCTS: KVNamespace;
  LINE_NOTIFY_TOKEN: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
  url: string;
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

const WATCH_KEYWORDS = ["Mac Studio", "Mac Mini"];

// Set to 0 to disable price filtering
const MAX_PRICE_TWD = 0;

const APPLE_REFURB_URL = "https://www.apple.com/tw/shop/refurbished/mac";

const FETCH_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
};

// ─────────────────────────────────────────────
//  FETCH PRODUCTS
// ─────────────────────────────────────────────

const LD_JSON_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

async function fetchRefurbProducts(): Promise<LdProduct[]> {
  const resp = await fetch(APPLE_REFURB_URL, { headers: FETCH_HEADERS });
  if (!resp.ok) throw new Error(`Apple page error: ${resp.status}`);

  const html = await resp.text();
  const products: LdProduct[] = [];

  for (const match of html.matchAll(LD_JSON_RE)) {
    const blob = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as LdProduct)["@type"] === "Product"
    ) {
      products.push(parsed as LdProduct);
    }
  }
  return products;
}

function parseProduct(p: LdProduct): Product | null {
  const name = p.name || "";
  const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  const price = Number(offer?.price) || 0;
  const id = offer?.sku || "";
  const url =
    p.url || "https://www.apple.com/tw/shop/refurbished/mac";

  if (!name || !id) return null;
  return { id, name, price, url };
}

function isTarget(product: Product): boolean {
  const nameLower = product.name.toLowerCase();
  const matched = WATCH_KEYWORDS.some((kw) =>
    nameLower.includes(kw.toLowerCase())
  );
  if (!matched) return false;
  if (MAX_PRICE_TWD && product.price && product.price > MAX_PRICE_TWD)
    return false;
  return true;
}

// ─────────────────────────────────────────────
//  LINE NOTIFY
// ─────────────────────────────────────────────

async function sendLineNotify(token: string, message: string): Promise<void> {
  const resp = await fetch("https://notify-api.line.me/api/notify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ message }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`LINE Notify failed: ${resp.status} ${body}`);
  } else {
    console.log("LINE Notify sent ✓");
  }
}

// ─────────────────────────────────────────────
//  KV HELPERS  (seen product IDs stored as JSON array)
// ─────────────────────────────────────────────

const KV_KEY = "seen_ids";

async function loadSeen(kv: KVNamespace): Promise<Set<string>> {
  const raw = await kv.get(KV_KEY);
  return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
}

async function saveSeen(kv: KVNamespace, seen: Set<string>): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify([...seen]));
}

// ─────────────────────────────────────────────
//  MAIN HANDLER
// ─────────────────────────────────────────────

async function checkRefurb(env: Env): Promise<void> {
  console.log(`[${new Date().toISOString()}] Checking Apple TW Refurbished Store...`);

  const seen = await loadSeen(env.SEEN_PRODUCTS);
  const rawProducts = await fetchRefurbProducts();
  console.log(`Fetched ${rawProducts.length} products`);

  const newItems: Product[] = [];

  for (const raw of rawProducts) {
    const product = parseProduct(raw);
    if (!product) continue;
    if (!isTarget(product)) continue;
    if (seen.has(product.id)) continue;

    newItems.push(product);
    seen.add(product.id);
  }

  if (newItems.length > 0) {
    console.log(`🆕 ${newItems.length} new item(s) found!`);
    for (const item of newItems) {
      const msg =
        `\n🖥️ Apple 整修品上架通知！\n` +
        `產品：${item.name}\n` +
        `價格：${item.price ? `NT$ ${item.price.toLocaleString()}` : "價格未知"}\n` +
        `連結：${item.url}`;
      console.log(msg);
      await sendLineNotify(env.LINE_NOTIFY_TOKEN, msg);
    }
    await saveSeen(env.SEEN_PRODUCTS, seen);
  } else {
    console.log("No new target products found.");
  }
}

// ─────────────────────────────────────────────
//  CLOUDFLARE WORKER ENTRY POINTS
// ─────────────────────────────────────────────

export default {
  // Cron trigger (scheduled)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkRefurb(env));
  },

  // HTTP trigger — lets you manually fire a check by visiting the Worker URL
  async fetch(_request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      await checkRefurb(env);
      return new Response("✅ Check complete. See Worker logs for details.", {
        status: 200,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`❌ Error: ${msg}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
