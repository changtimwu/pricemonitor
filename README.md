# 🖥️ Apple Refurb Tracker — Cloudflare Worker

Monitors Apple Taiwan's Refurbished Store for **Mac Studio** and **Mac Mini**,
runs every 30 minutes on Cloudflare Workers (no server needed), and pushes
alerts to LINE Notify.

---

## Project Structure

```
apple-refurb-tracker/
├── wrangler.toml      ← Cloudflare config + cron schedule
├── package.json
├── src/
│   └── index.js       ← Worker logic
└── README.md
```

---

## Deploy Steps

### 1. Install Wrangler
```bash
npm install
npx wrangler login
```

### 2. Create the KV namespace
```bash
npx wrangler kv:namespace create SEEN_PRODUCTS
```
Copy the `id` from the output and paste it into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "SEEN_PRODUCTS"
id = "PASTE_ID_HERE"
```

### 3. Set your LINE Notify secret
```bash
npx wrangler secret put LINE_NOTIFY_TOKEN
# Paste your token when prompted
```
Get a token at: https://notify-bot.line.me/my/

### 4. Deploy
```bash
npx wrangler deploy
```

### 5. Test manually
Visit your Worker URL in the browser — it will trigger an immediate check
and return a status message. Check logs with:
```bash
npx wrangler tail
```

---

## Cron Schedule

Configured in `wrangler.toml` as `*/30 * * * *` (every 30 minutes).
Change to `*/15 * * * *` for every 15 minutes, etc.

---

## TODO / Known Issues

- [ ] **Verify Apple API response shape** — the product list endpoint
      (`/tw/shop/product-list`) may return a different JSON structure.
      Use `wrangler tail` after first deploy to inspect `rawProducts` logs.
      If empty, check DevTools on `apple.com/tw/shop/refurbished/mac` for
      the actual XHR endpoint and update `APPLE_REFURB_URL` in `src/index.js`.
- [ ] Add price filter (`MAX_PRICE_TWD` in `src/index.js`)
- [ ] Optionally expand `WATCH_KEYWORDS` (e.g. `"MacBook Pro"`)
