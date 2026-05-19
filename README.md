# 🖥️ Apple Refurb Tracker — Cloudflare Worker

A POC multi-subscriber service. Anyone visits the public form, enters their
email + keywords + optional max-price, and gets emailed the moment a matching
item appears in Apple Taiwan's Refurbished Store. Runs every 30 minutes on
Cloudflare Workers, sends through [Resend](https://resend.com), stores subs in
Workers KV. No signup/login — unsubscribe via a one-click link in every email.

Live: https://apple-refurb-tracker.changtimwu.workers.dev

> **⚠️ POC limitation** — the deployed instance sends from Resend's testing
> address (`onboarding@resend.dev`), which only delivers to the Resend account
> owner. Subscribing other addresses saves the form but the email silently
> fails with 403. Verify a custom domain in Resend and update `EMAIL_FROM` in
> `src/index.ts` to make it a real multi-user service.

---

## How it works

1. **Fetch** — Worker GETs `https://www.apple.com/tw/shop/refurbished/mac` and
   extracts every `<script type="application/ld+json">` block. Schema.org
   `Product` entries are kept (`name`, `url`, `offers[0].{price,sku}`).
2. **Subscribers** — each is stored at KV key `sub:<uuid>` with
   `{ email, keywords[], maxPrice, createdAt, seenIds[] }`.
3. **Match** — for each sub, products are kept if `name` contains any
   keyword (whitespace-normalized, case-insensitive) and `price ≤ maxPrice`.
4. **Notify** — new matches (not in this sub's `seenIds`) are emailed in one
   message via Resend, then their SKUs are added to `seenIds`.

### Why whitespace-normalize?
Apple writes "MacBook Pro" with `U+00A0` (non-breaking space), not a regular
space. A user-typed `"MacBook Pro"` never matched until we collapsed
`/\s+/ → " "` on both sides.

---

## Routes

| Method · path | Purpose |
|---|---|
| `GET  /` | HTML subscription form |
| `POST /subscribe` | Body: `email`, `keywords` (comma-separated), `maxPrice` (optional). Creates `sub:<uuid>` in KV. |
| `GET  /unsubscribe/<id>` | Deletes the matching sub. Sent in every email. |
| `GET  /run` | Manually fire a check for all subs (same as cron). |

Cron: `*/30 * * * *` — runs `checkAllSubs` on the same code path as `/run`.

---

## Project layout

```
apple-refurb-tracker/
├── wrangler.toml      ← Cloudflare config + cron + KV binding
├── tsconfig.json
├── package.json
├── src/
│   └── index.ts       ← Worker (HTTP routes + cron + Resend)
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
Token scopes needed: **Workers Scripts: Edit**, **Workers KV Storage: Edit**,
**Account Settings: Read**.

### 2. Create the KV namespace
```bash
source .env
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
npx wrangler kv namespace create SEEN_PRODUCTS
```
Copy the printed `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Initial deploy (creates the Worker so secrets can be attached)
```bash
npm run deploy
```

### 4. Set the Resend secret
```bash
printf '%s' 'YOUR_RESEND_API_KEY' | npx wrangler secret put RESEND_API_KEY
```
Get an API key at https://resend.com/api-keys. To send to anyone besides the
Resend account owner, verify a domain at https://resend.com/domains and update
`EMAIL_FROM` in `src/index.ts`.

### 5. Subscribe
Open `https://<your-worker>.workers.dev/` in a browser, fill the form.

---

## Local development

```bash
npm run dev    # wrangler dev with Miniflare (KV simulated locally)
```

Then `curl` or open `http://localhost:8787/` to use the form. `GET /run`
triggers `checkAllSubs` against the local KV. Miniflare 3 does not auto-fire
scheduled events — pass `--test-scheduled` and visit
`http://localhost:8787/__scheduled?cron=*/30+*+*+*+*` to simulate cron.

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
GET https://apple-refurb-tracker.changtimwu.workers.dev/run - Ok
  (log) [2026-05-19T08:34:53.468Z] Running check for all subs...
  (log) Fetched 13 products
  (log) Loaded 1 subscriber(s)
  (log)   changtimwu@gmail.com: 2 new match(es)
  (log) Email sent to changtimwu@gmail.com ✓
```

Tail sessions expire after a few hours; rerun to reconnect. Also visible at
**Cloudflare dashboard → Workers & Pages → apple-refurb-tracker → Logs**.

---

## Operations

### List or inspect subs
```bash
source .env
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
NS=$(grep -oE 'id = "[a-f0-9]+"' wrangler.toml | head -1 | cut -d'"' -f2)

# list
npx wrangler kv key list --namespace-id "$NS" | jq '.[].name'

# inspect one
npx wrangler kv key get --namespace-id "$NS" "sub:<uuid>"
```

### Delete a sub by hand
```bash
npx wrangler kv key delete --namespace-id "$NS" "sub:<uuid>"
```

### Reset notification history for a sub
Edit the sub's JSON to set `seenIds: []` and put it back, or just unsubscribe
and re-subscribe.

---

## Hardening for real production use

The current code is intentionally a POC. Before pointing real users at it:

- Verify a sending domain in Resend and update `EMAIL_FROM`.
- Add rate-limiting on `POST /subscribe` (anyone can DoS the form).
- Add email-confirmation to prevent enumeration / signing up other people
  ("double opt-in").
- Enforce a per-sub-list cap and reject duplicate `(email, keywords)` pairs.
- Add basic abuse logging and a takedown path for spammed addresses.
