# 🖥️ Apple Refurb Tracker — Cloudflare Worker

A POC multi-subscriber service. Anyone visits the public form, enters their
email + keywords + optional max-price, and gets emailed the moment a matching
item appears in Apple Taiwan's Refurbished Store. Runs every 30 minutes on
Cloudflare Workers, sends through [Resend](https://resend.com), stores subs
and cached product specs in Workers KV. No signup/login — unsubscribe via a
one-click link in every email.

Live: https://apple-refurb-tracker.itsi.xyz

> **⚠️ POC limitation** — the deployed instance sends from Resend's testing
> address (`onboarding@resend.dev`), which only delivers to the Resend account
> owner. Subscribing other addresses saves the form but the email silently
> fails with 403. Verify a custom domain in Resend and update `EMAIL_FROM` in
> `src/index.ts` to make it a real multi-user service.

---

## How it works

1. **List** — Worker GETs `https://www.apple.com/tw/shop/refurbished/mac` and
   extracts every `<script type="application/ld+json">` block. Schema.org
   `Product` entries are kept (`name`, `url`, `offers[0].{price,sku}`).
2. **Match** — for each sub, products are kept if `name` contains any
   keyword (whitespace-normalized, case-insensitive) and `price ≤ maxPrice`.
3. **Enrich** — for each new match, `spec:<sku>` is looked up in KV; on miss,
   the detail page is fetched (raw HTTP first; falls back to Browser Rendering
   via `@cloudflare/puppeteer` if the spec section is missing). The cached
   record is `{ ram, storage, fetchedAt, source }`.
4. **Notify** — new matches are emailed in one Resend message per sub,
   including the enriched RAM/storage line, then their SKUs are added to
   the sub's `seenIds`.

### Key non-obvious findings

- **NBSP in product names** — Apple writes "MacBook Pro" with `U+00A0`
  (non-breaking space), not a regular space. A user-typed `"MacBook Pro"`
  never matched until we collapse `/\s+/ → " "` on both sides.
- **Specs are in initial HTML** — the "技術規格" accordion on each refurb
  detail page is CSS-collapsed only; the full spec text is already in the
  server-rendered HTML. `textContent` sees everything before any expansion,
  and raw `curl` returns the same data. So Browser Rendering is a fallback,
  not the hot path — saving the quota for genuine JS-rendered pages.
- **Refurb SKUs are immutable** — once Apple assigns a SKU like `G1KK3TA/A`,
  the config never changes. We can cache enriched specs forever (no TTL).

---

## KV layout

| Key                              | Value (JSON)                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `sub:<uuid>`                     | `{ id, email, keywords[], maxPrice, createdAt, seenIds[] }`                 |
| `spec:<sku>`                     | `{ ram, storage, fetchedAt, source: "raw" \| "browser" }`                   |

---

## Routes

| Method · path             | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `GET  /`                  | HTML subscription form                                               |
| `POST /subscribe`         | Form body: `email`, `keywords` (comma-sep), `maxPrice` (optional). Saves `sub:<uuid>`. |
| `GET  /unsubscribe/<id>`  | Deletes the matching sub. Included in every email.                   |
| `GET  /run`               | Manually fire a check for all subs (same code path as cron).         |

Cron: `*/30 * * * *` — runs `checkAllSubs` on the same code path as `/run`.

---

## Project layout

```
apple-refurb-tracker/
├── wrangler.toml      ← Cloudflare config: routes, cron, KV, browser binding, vars
├── tsconfig.json
├── package.json
├── src/
│   └── index.ts       ← Worker (HTTP routes + cron + Resend + enrichment)
└── dist/              ← Compiled JS (gitignored)
```

---

## Deploy from scratch

```bash
npm install
```

### 1. Cloudflare auth
Either `npx wrangler login`, or put a token in `.env` (it's gitignored):
```
CLOUDFLARE_API_TOKEN=...
```
Token scopes:
- **Workers Scripts: Edit**
- **Workers KV Storage: Edit**
- **Zone.Workers Routes: Edit** + **Zone.DNS: Edit** (if binding a custom domain)
- **Zone.Workers Routes: Read** (silences a 403 on deploy follow-up call)
- **Account Settings: Read**
- **Browser Rendering: Edit**

### 2. Create the KV namespace
```bash
source .env
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npx wrangler kv namespace create SEEN_PRODUCTS
```
Paste the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. (Optional) Custom domain
Add to `wrangler.toml`:
```toml
routes = [
  { pattern = "apple-refurb-tracker.your-zone.com", custom_domain = true }
]
```
Cloudflare auto-creates the proxied DNS record + TLS cert on first deploy.

### 4. Initial deploy (creates the Worker so secrets can be attached)
```bash
npm run deploy
```

### 5. Set the Resend secret
```bash
printf '%s' 'YOUR_RESEND_API_KEY' | npx wrangler secret put RESEND_API_KEY
```
Get an API key at https://resend.com/api-keys. To send to anyone besides the
Resend account owner, verify a sending domain at https://resend.com/domains
and update `EMAIL_FROM` in `src/index.ts`.

### 6. Subscribe
Open the worker URL in a browser, fill the form.

---

## Cloudflare requirements

- **Workers Paid plan ($5/mo)** — needed for the `[browser]` binding
  (`@cloudflare/puppeteer`). Without it, the binding is missing and the
  fallback path will throw.
- **`nodejs_compat`** flag (already in `wrangler.toml`) — `@cloudflare/puppeteer`
  imports `node:buffer`.
- **`compatibility_date = "2024-09-23"`** or newer.

---

## Local development

```bash
npm run dev    # wrangler dev with Miniflare (KV simulated locally)
```

Miniflare 3 doesn't expose the `BROWSER` binding locally. If you need to
exercise the puppeteer fallback path, run against the real Cloudflare edge:
```bash
source .env
npx wrangler dev --remote --port 8787
```
This uses **real** production resources (KV, secrets, Browser Rendering
quota) — so writes to KV during dev actually persist.

Cron doesn't auto-fire in `wrangler dev`. To simulate, GET `/run`, or for the
proper scheduled handler, `curl http://localhost:8787/cdn-cgi/handler/scheduled`.

---

## Check logs

Live tail of the deployed Worker:
```bash
source .env
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npx wrangler tail --format pretty
```

Typical output:
```
GET https://apple-refurb-tracker.itsi.xyz/run - Ok
  (log) [2026-05-19T09:16:49.831Z] Running check for all subs...
  (log) Fetched 13 products
  (log) Loaded 1 subscriber(s)
  (log)   changtimwu@gmail.com: 2 new match(es)
  (log) Email sent to changtimwu@gmail.com ✓
```

If the raw detail-page fetch ever misses the spec section, you'll also see:
```
  (log)   raw fetch missing specs for <SKU>; using browser fallback
  (log)   browser-render https://www.apple.com/tw/shop/product/<sku>/...
```

Also visible at **Cloudflare dashboard → Workers & Pages → apple-refurb-tracker
→ Logs**, and Browser Rendering quota usage at **Workers & Pages → Browser
Rendering → Analytics**.

---

## Operations

> Note: `wrangler kv key list` has shown stale output in our testing —
> when in doubt, hit the REST API directly.

### List all KV records
```bash
source .env
NS=$(grep -oE 'id = "[a-f0-9]+"' wrangler.toml | head -1 | cut -d'"' -f2)
ACCT=$(grep -oE 'account_id = "[a-f0-9]+"' wrangler.toml | cut -d'"' -f2)

curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/keys?limit=1000" \
  | jq '.result[].name'
```

### Inspect a sub or spec record
```bash
KEY="sub:<uuid>"   # or "spec:G1KK3TA/A"
ENC=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$KEY")
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/values/$ENC"
```

### Delete a sub
Either use the public unsubscribe URL:
```bash
curl https://<your-worker>.example.com/unsubscribe/<uuid>
```
or via the API:
```bash
curl -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/values/sub:<uuid>"
```

### Invalidate a cached spec
Delete the `spec:<SKU>` record. The next run will re-fetch and re-cache.

### Reset notification history for a sub
Edit the sub's JSON to set `seenIds: []` and `PUT` it back, or just
unsubscribe and re-subscribe.

---

## Hardening for real production use

The current code is intentionally a POC. Before pointing real users at it:

- Verify a sending domain in Resend and update `EMAIL_FROM`.
- Add rate-limiting on `POST /subscribe` (anyone can DoS the form).
- Add email-confirmation to prevent enumeration / signing up other people
  ("double opt-in").
- Enforce a per-sub-list cap and reject duplicate `(email, keywords)` pairs.
- Add basic abuse logging and a takedown path for spammed addresses.
- Set a budget alert on the Browser Rendering quota in case the fallback
  path is ever triggered en masse.
